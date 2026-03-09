package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"shelley.exe.dev/db"
	"shelley.exe.dev/db/generated"
	"shelley.exe.dev/llm"
)

type JobKind string
type JobStatus string

const (
	JobKindTurn     JobKind = "turn"
	JobKindSubagent JobKind = "subagent"
	JobKindDistill  JobKind = "distill"
)

const (
	JobStatusQueued    JobStatus = "queued"
	JobStatusRunning   JobStatus = "running"
	JobStatusSucceeded JobStatus = "succeeded"
	JobStatusFailed    JobStatus = "failed"
	JobStatusCanceled  JobStatus = "canceled"
	JobStatusTimedOut  JobStatus = "timed_out"
)

type StartJobParams struct {
	ConversationID   string
	ParentJobID      *string
	Kind             JobKind
	TriggerMessageID *string
	ModelID          string
	TimeoutSeconds   *int64
	Input            any
}

type FinishJobParams struct {
	JobID        string
	Status       JobStatus
	Output       any
	ErrorPayload any
}

type JobService struct {
	db     *db.DB
	logger *slog.Logger
}

func NewJobService(database *db.DB, logger *slog.Logger) *JobService {
	return &JobService{db: database, logger: logger}
}

func marshalOptionalJSON(payload any) (*string, error) {
	if payload == nil {
		return nil, nil
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	value := string(data)
	return &value, nil
}

func stringPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (s *JobService) StartJob(ctx context.Context, params StartJobParams) (*generated.JobRun, error) {
	inputJSON, err := marshalEventPayload(params.Input)
	if err != nil {
		return nil, err
	}

	jobID := "j" + strings.ReplaceAll(uuid.NewString(), "-", "")
	now := time.Now()
	modelID := stringPtr(params.ModelID)

	var job generated.JobRun
	err = s.db.WithTx(ctx, func(q *generated.Queries) error {
		job, err = q.CreateJobRun(ctx, generated.CreateJobRunParams{
			JobID:            jobID,
			ConversationID:   params.ConversationID,
			ParentJobID:      params.ParentJobID,
			Kind:             string(params.Kind),
			Status:           string(JobStatusRunning),
			TriggerMessageID: params.TriggerMessageID,
			ModelID:          modelID,
			TimeoutSeconds:   params.TimeoutSeconds,
			InputJson:        inputJSON,
			OutputJson:       nil,
			ErrorJson:        nil,
			AttemptCount:     1,
			StartedAt:        &now,
			FinishedAt:       nil,
		})
		if err != nil {
			return err
		}

		runtime, err := upsertConversationRuntimeStateTx(ctx, q, params.ConversationID, true, &job.JobID, modelID)
		if err != nil {
			return err
		}
		if _, err := appendConversationEventTx(ctx, q, params.ConversationID, &job.JobID, nil, eventTypeJobCreated, job); err != nil {
			return err
		}
		if _, err := appendConversationEventTx(ctx, q, params.ConversationID, &job.JobID, nil, eventTypeConversationStateChanged, runtime); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	return &job, nil
}

func (s *JobService) FinishJob(ctx context.Context, params FinishJobParams) (*generated.JobRun, error) {
	outputJSON, err := marshalOptionalJSON(params.Output)
	if err != nil {
		return nil, err
	}
	errorJSON, err := marshalOptionalJSON(params.ErrorPayload)
	if err != nil {
		return nil, err
	}

	finishedAt := time.Now()
	var job generated.JobRun
	err = s.db.WithTx(ctx, func(q *generated.Queries) error {
		current, err := q.GetJobRun(ctx, params.JobID)
		if err != nil {
			return err
		}

		job, err = q.UpdateJobRunLifecycle(ctx, generated.UpdateJobRunLifecycleParams{
			Status:       string(params.Status),
			ModelID:      current.ModelID,
			OutputJson:   outputJSON,
			ErrorJson:    errorJSON,
			AttemptCount: current.AttemptCount,
			StartedAt:    current.StartedAt,
			FinishedAt:   &finishedAt,
			JobID:        params.JobID,
		})
		if err != nil {
			return err
		}

		runtime, err := upsertConversationRuntimeStateTx(ctx, q, current.ConversationID, false, nil, current.ModelID)
		if err != nil {
			return err
		}
		if _, err := appendConversationEventTx(ctx, q, current.ConversationID, &job.JobID, nil, eventTypeJobUpdated, job); err != nil {
			return err
		}
		if _, err := appendConversationEventTx(ctx, q, current.ConversationID, &job.JobID, nil, eventTypeConversationStateChanged, runtime); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	return &job, nil
}

func (s *JobService) CompleteActiveJobFromMessage(ctx context.Context, conversationID string, createdMsg *generated.Message, message llm.Message) error {
	if !message.EndOfTurn {
		return nil
	}

	runtime, err := s.db.GetConversationRuntime(ctx, conversationID)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil
		}
		return err
	}
	if runtime.ActiveJobID == nil {
		return nil
	}

	job, err := s.db.GetJobRun(ctx, *runtime.ActiveJobID)
	if err != nil {
		return err
	}
	if job.Kind != string(JobKindTurn) && job.Kind != string(JobKindSubagent) {
		return nil
	}
	if job.Status != string(JobStatusRunning) && job.Status != string(JobStatusQueued) {
		return nil
	}

	status := JobStatusSucceeded
	var errorPayload any
	if message.ErrorType != llm.ErrorTypeNone {
		status = JobStatusFailed
		errorPayload = map[string]any{
			"error_type": string(message.ErrorType),
		}
	} else if isCancellationMessage(message) {
		status = JobStatusCanceled
		errorPayload = map[string]any{
			"reason": "cancelled",
		}
	}

	output := map[string]any{
		"message_id":  createdMsg.MessageID,
		"sequence_id": createdMsg.SequenceID,
		"type":        createdMsg.Type,
		"end_of_turn": true,
	}

	_, err = s.FinishJob(ctx, FinishJobParams{
		JobID:        job.JobID,
		Status:       status,
		Output:       output,
		ErrorPayload: errorPayload,
	})
	return err
}

func isCancellationMessage(message llm.Message) bool {
	for _, content := range message.Content {
		if content.Type == llm.ContentTypeText && strings.Contains(content.Text, "[Operation cancelled]") {
			return true
		}
	}
	return false
}

func (s *JobService) Get(ctx context.Context, jobID string) (*generated.JobRun, error) {
	return s.db.GetJobRun(ctx, jobID)
}

func (s *JobService) ListForConversation(ctx context.Context, conversationID string, limit int64) ([]generated.JobRun, error) {
	return s.db.ListJobRunsForConversation(ctx, conversationID, limit)
}

func (s *JobService) ActiveJobID(ctx context.Context, conversationID string) (*string, error) {
	runtime, err := s.db.GetConversationRuntime(ctx, conversationID)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return runtime.ActiveJobID, nil
}

func (s *JobService) ReconcileInterruptedJobs(ctx context.Context) error {
	var jobs []generated.JobRun
	err := s.db.Pool().Rx(ctx, func(ctx context.Context, rx *db.Rx) error {
		q := generated.New(rx.Conn())
		var err error
		jobs, err = q.ListIncompleteJobRuns(ctx)
		return err
	})
	if err != nil {
		return err
	}

	for _, job := range jobs {
		if _, err := s.FinishJob(ctx, FinishJobParams{
			JobID:  job.JobID,
			Status: JobStatusFailed,
			ErrorPayload: map[string]any{
				"reason": "server_restart",
			},
		}); err != nil {
			return fmt.Errorf("reconcile job %s: %w", job.JobID, err)
		}
	}
	return nil
}
