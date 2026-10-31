package breaker

import (
	"errors"
	"testing"
	"time"
)

// fakeClock lets the test move time forward without sleeping.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { return c.t }

func TestBreakerLifecycle(t *testing.T) {
	clock := &fakeClock{t: time.Unix(0, 0)}
	var transitions []string
	b := New("user-service", 3, 10*time.Second, func(_ string, from, to State) {
		transitions = append(transitions, from.String()+"→"+to.String())
	})
	b.now = clock.now

	// Three consecutive failures open the circuit.
	for i := 0; i < 3; i++ {
		if err := b.Allow(); err != nil {
			t.Fatalf("call %d: unexpected %v", i, err)
		}
		b.Record(true)
	}
	if got := b.State(); got != Open {
		t.Fatalf("state = %v, want open", got)
	}

	// While open, calls fail fast.
	if err := b.Allow(); !errors.Is(err, ErrOpen) {
		t.Fatalf("Allow while open = %v, want ErrOpen", err)
	}

	// After the cool-down one probe is allowed; a second concurrent probe is not.
	clock.t = clock.t.Add(10 * time.Second)
	if err := b.Allow(); err != nil {
		t.Fatalf("probe rejected: %v", err)
	}
	if err := b.Allow(); !errors.Is(err, ErrOpen) {
		t.Fatalf("second probe = %v, want ErrOpen", err)
	}

	// A successful probe closes the circuit.
	b.Record(false)
	if got := b.State(); got != Closed {
		t.Fatalf("state = %v, want closed", got)
	}

	want := []string{"closed→open", "open→half-open", "half-open→closed"}
	if len(transitions) != len(want) {
		t.Fatalf("transitions = %v, want %v", transitions, want)
	}
	for i := range want {
		if transitions[i] != want[i] {
			t.Fatalf("transitions = %v, want %v", transitions, want)
		}
	}
}

func TestSuccessResetsFailureCount(t *testing.T) {
	b := New("x", 3, time.Second, nil)
	for _, failed := range []bool{true, true, false, true, true} {
		_ = b.Allow()
		b.Record(failed)
	}
	if got := b.State(); got != Closed {
		t.Fatalf("state = %v, want closed (failures were not consecutive)", got)
	}
}
