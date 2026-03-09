package server

import (
	"testing"
	"time"
)

func TestConsumePendingCodexAuthIsPerState(t *testing.T) {
	s := &Server{
		pendingCodexAuth: make(map[string]codexAuthState),
	}

	first := codexAuthState{
		CodeVerifier: "first-verifier",
		State:        "first-state",
		ExpiresAt:    time.Now().Add(time.Minute),
	}
	second := codexAuthState{
		CodeVerifier: "second-verifier",
		State:        "second-state",
		ExpiresAt:    time.Now().Add(time.Minute),
	}

	s.storePendingCodexAuth(first)
	s.storePendingCodexAuth(second)

	got, ok := s.consumePendingCodexAuth(first.State)
	if !ok {
		t.Fatal("expected first state to be present")
	}
	if got.CodeVerifier != first.CodeVerifier {
		t.Fatalf("consumePendingCodexAuth(%q) verifier = %q, want %q", first.State, got.CodeVerifier, first.CodeVerifier)
	}

	if _, ok := s.consumePendingCodexAuth(first.State); ok {
		t.Fatal("expected consumed state to be removed")
	}

	got, ok = s.consumePendingCodexAuth(second.State)
	if !ok {
		t.Fatal("expected second state to remain after consuming first")
	}
	if got.CodeVerifier != second.CodeVerifier {
		t.Fatalf("consumePendingCodexAuth(%q) verifier = %q, want %q", second.State, got.CodeVerifier, second.CodeVerifier)
	}
}
