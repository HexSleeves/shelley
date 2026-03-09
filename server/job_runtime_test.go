package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"log/slog"
	"os"

	"shelley.exe.dev/claudetool"
	"shelley.exe.dev/db"
	"shelley.exe.dev/db/generated"
	"shelley.exe.dev/llm"
	"shelley.exe.dev/loop"
)

func TestTurnJobsAndEventsPersist(t *testing.T) {
	server, database, _ := newTestServer(t)

	body := `{"message":"echo: phase 2 turn","model":"predictable"}`
	req := httptest.NewRequest(http.MethodPost, "/api/conversations/new", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	server.handleNewConversation(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected status 201, got %d: %s", w.Code, w.Body.String())
	}

	var created struct {
		ConversationID string `json:"conversation_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode conversation response: %v", err)
	}

	waitFor(t, 5*time.Second, func() bool {
		runtime, err := database.GetConversationRuntime(context.Background(), created.ConversationID)
		if err != nil || runtime.Working {
			return false
		}
		jobs, err := database.ListJobRunsForConversation(context.Background(), created.ConversationID, 10)
		return err == nil && len(jobs) == 1 && jobs[0].Status == string(JobStatusSucceeded)
	})

	runtime, err := database.GetConversationRuntime(context.Background(), created.ConversationID)
	if err != nil {
		t.Fatalf("failed to get runtime: %v", err)
	}
	if runtime.Working {
		t.Fatal("expected runtime to be idle")
	}
	if runtime.ActiveJobID != nil {
		t.Fatalf("expected no active job, got %q", *runtime.ActiveJobID)
	}
	if runtime.LastEventID == 0 {
		t.Fatal("expected last_event_id to be set")
	}

	jobs, err := database.ListJobRunsForConversation(context.Background(), created.ConversationID, 10)
	if err != nil {
		t.Fatalf("failed to list jobs: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("expected 1 job, got %d", len(jobs))
	}
	job := jobs[0]
	if job.Kind != string(JobKindTurn) {
		t.Fatalf("expected turn job, got %q", job.Kind)
	}
	if job.Status != string(JobStatusSucceeded) {
		t.Fatalf("expected succeeded job, got %q", job.Status)
	}

	events, err := database.ListConversationEventsSince(context.Background(), created.ConversationID, 0)
	if err != nil {
		t.Fatalf("failed to list events: %v", err)
	}
	counts := countEventTypes(events)
	if counts[eventTypeJobCreated] != 1 {
		t.Fatalf("expected 1 job.created event, got %d", counts[eventTypeJobCreated])
	}
	if counts[eventTypeJobUpdated] != 1 {
		t.Fatalf("expected 1 job.updated event, got %d", counts[eventTypeJobUpdated])
	}
	if counts[eventTypeMessageCreated] < 2 {
		t.Fatalf("expected at least 2 message.created events, got %d", counts[eventTypeMessageCreated])
	}
	if counts[eventTypeConversationStateChanged] < 2 {
		t.Fatalf("expected at least 2 conversation.state.changed events, got %d", counts[eventTypeConversationStateChanged])
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/conversation/"+created.ConversationID, nil)
	getW := httptest.NewRecorder()
	server.handleGetConversation(getW, getReq, created.ConversationID)
	if getW.Code != http.StatusOK {
		t.Fatalf("expected conversation get status 200, got %d: %s", getW.Code, getW.Body.String())
	}
	var response StreamResponse
	if err := json.Unmarshal(getW.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode conversation response: %v", err)
	}
	if response.Runtime == nil {
		t.Fatal("expected runtime in conversation response")
	}
	if response.LastEventID != runtime.LastEventID {
		t.Fatalf("expected last_event_id %d, got %d", runtime.LastEventID, response.LastEventID)
	}

	jobsReq := httptest.NewRequest(http.MethodGet, "/api/conversation/"+created.ConversationID+"/jobs", nil)
	jobsW := httptest.NewRecorder()
	server.handleGetConversationJobs(jobsW, jobsReq, created.ConversationID)
	if jobsW.Code != http.StatusOK {
		t.Fatalf("expected conversation jobs status 200, got %d: %s", jobsW.Code, jobsW.Body.String())
	}
	var listedJobs []generated.JobRun
	if err := json.Unmarshal(jobsW.Body.Bytes(), &listedJobs); err != nil {
		t.Fatalf("failed to decode conversation jobs response: %v", err)
	}
	if len(listedJobs) != 1 || listedJobs[0].JobID != job.JobID {
		t.Fatalf("unexpected jobs response: %+v", listedJobs)
	}

	jobReq := httptest.NewRequest(http.MethodGet, "/api/jobs/"+job.JobID, nil)
	jobW := httptest.NewRecorder()
	server.handleGetJob(jobW, jobReq, job.JobID)
	if jobW.Code != http.StatusOK {
		t.Fatalf("expected job status 200, got %d: %s", jobW.Code, jobW.Body.String())
	}
	var fetchedJob generated.JobRun
	if err := json.Unmarshal(jobW.Body.Bytes(), &fetchedJob); err != nil {
		t.Fatalf("failed to decode job response: %v", err)
	}
	if fetchedJob.JobID != job.JobID {
		t.Fatalf("expected job %q, got %q", job.JobID, fetchedJob.JobID)
	}
}

func TestSubagentJobPersistsParentLinkage(t *testing.T) {
	server, database, _ := newTestServer(t)

	parentConversation, err := database.CreateConversation(context.Background(), nil, true, nil, nil)
	if err != nil {
		t.Fatalf("failed to create parent conversation: %v", err)
	}

	chatReq := httptest.NewRequest(http.MethodPost, "/api/conversation/"+parentConversation.ConversationID+"/chat", strings.NewReader(`{"message":"delay: 2","model":"predictable"}`))
	chatReq.Header.Set("Content-Type", "application/json")
	chatW := httptest.NewRecorder()
	server.handleChatConversation(chatW, chatReq, parentConversation.ConversationID)
	if chatW.Code != http.StatusAccepted {
		t.Fatalf("expected status 202, got %d: %s", chatW.Code, chatW.Body.String())
	}

	var parentRuntime *generated.ConversationRuntime
	waitFor(t, 5*time.Second, func() bool {
		var err error
		parentRuntime, err = database.GetConversationRuntime(context.Background(), parentConversation.ConversationID)
		return err == nil && parentRuntime.Working && parentRuntime.ActiveJobID != nil
	})

	subagentConversation, err := database.CreateSubagentConversation(context.Background(), "worker", parentConversation.ConversationID, nil)
	if err != nil {
		t.Fatalf("failed to create subagent conversation: %v", err)
	}

	runner := NewSubagentRunner(server)
	if _, err := runner.RunSubagent(context.Background(), subagentConversation.ConversationID, "echo: child task", true, 5*time.Second, "predictable"); err != nil {
		t.Fatalf("failed to run subagent: %v", err)
	}

	waitFor(t, 5*time.Second, func() bool {
		runtime, err := database.GetConversationRuntime(context.Background(), subagentConversation.ConversationID)
		if err != nil || runtime.Working {
			return false
		}
		jobs, err := database.ListJobRunsForConversation(context.Background(), subagentConversation.ConversationID, 10)
		return err == nil && len(jobs) == 1 && jobs[0].Status == string(JobStatusSucceeded)
	})

	jobs, err := database.ListJobRunsForConversation(context.Background(), subagentConversation.ConversationID, 10)
	if err != nil {
		t.Fatalf("failed to list subagent jobs: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("expected 1 subagent job, got %d", len(jobs))
	}
	job := jobs[0]
	if job.Kind != string(JobKindSubagent) {
		t.Fatalf("expected subagent job, got %q", job.Kind)
	}
	if job.ParentJobID == nil || *job.ParentJobID != *parentRuntime.ActiveJobID {
		t.Fatalf("expected parent job %q, got %+v", *parentRuntime.ActiveJobID, job.ParentJobID)
	}
}

func TestDistillJobPersists(t *testing.T) {
	server, database, _ := newTestServer(t)

	sourceSlug := "source"
	sourceConversation, err := database.CreateConversation(context.Background(), &sourceSlug, true, nil, stringPtr("predictable"))
	if err != nil {
		t.Fatalf("failed to create source conversation: %v", err)
	}

	if _, err := database.CreateMessage(context.Background(), db.CreateMessageParams{
		ConversationID: sourceConversation.ConversationID,
		Type:           db.MessageTypeUser,
		LLMData: llm.Message{
			Role:    llm.MessageRoleUser,
			Content: []llm.Content{{Type: llm.ContentTypeText, Text: "build a distillation"}},
		},
	}); err != nil {
		t.Fatalf("failed to create source user message: %v", err)
	}
	if _, err := database.CreateMessage(context.Background(), db.CreateMessageParams{
		ConversationID: sourceConversation.ConversationID,
		Type:           db.MessageTypeAgent,
		LLMData: llm.Message{
			Role:      llm.MessageRoleAssistant,
			EndOfTurn: true,
			Content:   []llm.Content{{Type: llm.ContentTypeText, Text: "done"}},
		},
	}); err != nil {
		t.Fatalf("failed to create source agent message: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/conversations/distill", strings.NewReader(`{"source_conversation_id":"`+sourceConversation.ConversationID+`","model":"predictable"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.handleDistillConversation(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected status 201, got %d: %s", w.Code, w.Body.String())
	}

	var created struct {
		ConversationID string `json:"conversation_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode distill response: %v", err)
	}

	waitFor(t, 5*time.Second, func() bool {
		runtime, err := database.GetConversationRuntime(context.Background(), created.ConversationID)
		if err != nil || runtime.Working {
			return false
		}
		jobs, err := database.ListJobRunsForConversation(context.Background(), created.ConversationID, 10)
		return err == nil && len(jobs) == 1 && jobs[0].Status == string(JobStatusSucceeded)
	})

	jobs, err := database.ListJobRunsForConversation(context.Background(), created.ConversationID, 10)
	if err != nil {
		t.Fatalf("failed to list distill jobs: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("expected 1 distill job, got %d", len(jobs))
	}
	if jobs[0].Kind != string(JobKindDistill) {
		t.Fatalf("expected distill job, got %q", jobs[0].Kind)
	}

	events, err := database.ListConversationEventsSince(context.Background(), created.ConversationID, 0)
	if err != nil {
		t.Fatalf("failed to list distill events: %v", err)
	}
	counts := countEventTypes(events)
	if counts[eventTypeMessageUpdated] == 0 {
		t.Fatal("expected a message.updated event for distill status")
	}
	if counts[eventTypeJobCreated] != 1 || counts[eventTypeJobUpdated] != 1 {
		t.Fatalf("unexpected job event counts: %+v", counts)
	}
}

func TestReconcileInterruptedJobs(t *testing.T) {
	database, cleanup := setupTestDB(t)
	t.Cleanup(cleanup)

	conversation, err := database.CreateConversation(context.Background(), nil, true, nil, stringPtr("predictable"))
	if err != nil {
		t.Fatalf("failed to create conversation: %v", err)
	}

	jobID := "j-reconcile"
	inputJSON := `{"message":"reconcile me"}`
	now := time.Now()
	if err := database.QueriesTx(context.Background(), func(q *generated.Queries) error {
		if _, err := q.CreateJobRun(context.Background(), generated.CreateJobRunParams{
			JobID:            jobID,
			ConversationID:   conversation.ConversationID,
			ParentJobID:      nil,
			Kind:             string(JobKindTurn),
			Status:           string(JobStatusRunning),
			TriggerMessageID: nil,
			ModelID:          stringPtr("predictable"),
			TimeoutSeconds:   nil,
			InputJson:        inputJSON,
			OutputJson:       nil,
			ErrorJson:        nil,
			AttemptCount:     1,
			StartedAt:        &now,
			FinishedAt:       nil,
		}); err != nil {
			return err
		}
		_, err := q.UpsertConversationRuntimeState(context.Background(), generated.UpsertConversationRuntimeStateParams{
			ConversationID: conversation.ConversationID,
			Working:        true,
			ActiveJobID:    &jobID,
			CurrentModelID: stringPtr("predictable"),
		})
		return err
	}); err != nil {
		t.Fatalf("failed to seed running job: %v", err)
	}

	_ = NewServer(
		database,
		&testLLMManager{service: loop.NewPredictableService()},
		claudetool.ToolSetConfig{EnableBrowser: false},
		slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelWarn})),
		true,
		"",
		"predictable",
		"",
		nil,
		nil,
		"",
	)

	job, err := database.GetJobRun(context.Background(), jobID)
	if err != nil {
		t.Fatalf("failed to get reconciled job: %v", err)
	}
	if job.Status != string(JobStatusFailed) {
		t.Fatalf("expected failed job after reconciliation, got %q", job.Status)
	}

	runtime, err := database.GetConversationRuntime(context.Background(), conversation.ConversationID)
	if err != nil {
		t.Fatalf("failed to get reconciled runtime: %v", err)
	}
	if runtime.Working {
		t.Fatal("expected runtime to be idle after reconciliation")
	}
	if runtime.ActiveJobID != nil {
		t.Fatalf("expected no active job after reconciliation, got %+v", runtime.ActiveJobID)
	}
}

func countEventTypes(events []generated.ConversationEvent) map[string]int {
	counts := make(map[string]int)
	for _, event := range events {
		counts[event.EventType]++
	}
	return counts
}
