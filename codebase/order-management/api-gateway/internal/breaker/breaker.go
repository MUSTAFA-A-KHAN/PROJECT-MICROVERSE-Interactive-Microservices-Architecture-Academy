// Package breaker is a small, dependency-free circuit breaker.
//
// It is written by hand (instead of using a library, as Order Service does)
// so every state transition is visible:
//
//	CLOSED    — calls pass; consecutive failures are counted.
//	OPEN      — calls fail immediately for the cool-down period.
//	HALF-OPEN — a limited number of probe calls test whether the dependency
//	            recovered: success closes the circuit, failure re-opens it.
package breaker

import (
	"errors"
	"sync"
	"time"
)

// State is the breaker's current mode.
type State int

const (
	Closed State = iota
	Open
	HalfOpen
)

func (s State) String() string {
	switch s {
	case Closed:
		return "closed"
	case Open:
		return "open"
	default:
		return "half-open"
	}
}

// ErrOpen is returned by Allow while the circuit is open (or while half-open
// and all probe slots are taken).
var ErrOpen = errors.New("circuit breaker is open")

// Breaker is safe for concurrent use.
type Breaker struct {
	name        string
	threshold   int           // consecutive failures that open the circuit
	cooldown    time.Duration // how long to stay open
	maxProbes   int           // concurrent calls allowed while half-open
	onChange    func(name string, from, to State)
	now         func() time.Time

	mu       sync.Mutex
	state    State
	failures int
	openedAt time.Time
	probes   int
}

// New returns a closed breaker. onChange may be nil.
func New(name string, threshold int, cooldown time.Duration, onChange func(name string, from, to State)) *Breaker {
	return &Breaker{name: name, threshold: threshold, cooldown: cooldown, maxProbes: 1, onChange: onChange, now: time.Now}
}

// Allow reports whether a call may proceed. Every successful Allow must be
// followed by exactly one Record.
func (b *Breaker) Allow() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch b.state {
	case Open:
		if b.now().Sub(b.openedAt) < b.cooldown {
			return ErrOpen
		}
		b.setState(HalfOpen)
		fallthrough
	case HalfOpen:
		if b.probes >= b.maxProbes {
			return ErrOpen
		}
		b.probes++
	}
	return nil
}

// Record reports the outcome of a call that Allow permitted.
func (b *Breaker) Record(failed bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state == HalfOpen {
		b.probes--
		if failed {
			b.trip()
		} else {
			b.failures = 0
			b.setState(Closed)
		}
		return
	}
	if !failed {
		b.failures = 0
		return
	}
	b.failures++
	if b.state == Closed && b.failures >= b.threshold {
		b.trip()
	}
}

// State returns the current state (for metrics and health endpoints).
func (b *Breaker) State() State {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.state
}

// RetryAfter is how long until the breaker will allow a probe.
func (b *Breaker) RetryAfter() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state != Open {
		return 0
	}
	return max(0, b.cooldown-b.now().Sub(b.openedAt))
}

func (b *Breaker) trip() {
	b.openedAt = b.now()
	b.probes = 0
	b.setState(Open)
}

func (b *Breaker) setState(s State) {
	if b.state == s {
		return
	}
	from := b.state
	b.state = s
	if b.onChange != nil {
		// Called with the lock held: callbacks must be fast and must not call back into the breaker.
		b.onChange(b.name, from, s)
	}
}
