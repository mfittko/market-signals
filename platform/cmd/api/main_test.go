package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"reflect"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseOriginsAcceptsHostPortAndOriginForms(t *testing.T) {
	got := parseOrigins(" localhost:3000, http://console.lan:3000 ,https://ops.example/, box:3000/path,,")
	want := []string{"localhost:3000", "console.lan:3000", "ops.example", "box:3000"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseOrigins = %q, want %q", got, want)
	}
}

// recorder collects run's events and the loops' own steps in one ordered list.
type recorder struct {
	mu     sync.Mutex
	events []string
}

func (r *recorder) add(e string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, e)
}

func (r *recorder) list() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.events...)
}

// testPlane counts loop passes and records loop exits and the pool close.
func testPlane(addr string, rec *recorder, passes *atomic.Int32, served chan<- struct{}) plane {
	loop := func(name string) func(context.Context) {
		return func(ctx context.Context) {
			passes.Add(1)
			<-ctx.Done()
			rec.add(name + " returned")
		}
	}
	return plane{
		addr:    addr,
		log:     slog.New(slog.DiscardHandler),
		handler: http.NotFoundHandler(),
		reaper:  loop("reaper"),
		monitor: loop("monitor"),
		close:   func() { rec.add("pool closed") },
		event: func(e string) {
			rec.add(e)
			if e == "serve" && served != nil {
				close(served)
			}
		},
	}
}

func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}

func TestRunOnAnOccupiedPortFailsBeforeAnyLoop(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var rec recorder
	var passes atomic.Int32
	if err := run(context.Background(), testPlane(ln.Addr().String(), &rec, &passes, nil)); err == nil {
		t.Fatal("run on an occupied port must return an error")
	}
	if n := passes.Load(); n != 0 {
		t.Fatalf("reaper and monitor ran %d passes after a failed bind", n)
	}
	if ev := rec.list(); len(ev) != 0 {
		t.Fatalf("events after a failed bind: %q", ev)
	}
}

func TestRunBindsThenStartsLoopsThenServes(t *testing.T) {
	var rec recorder
	var passes atomic.Int32
	served := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	addr := freeAddr(t)
	done := make(chan error, 1)
	go func() { done <- run(ctx, testPlane(addr, &rec, &passes, served)) }()
	awaitServe(t, served, done)
	if got, want := rec.list()[:4], []string{"listen", "reaper", "monitor", "serve"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("startup order %q, want %q", got, want)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// awaitServe fails the test when run returns or stalls before it serves.
func awaitServe(t *testing.T, served <-chan struct{}, done <-chan error) {
	t.Helper()
	select {
	case <-served:
	case err := <-done:
		t.Fatalf("run returned before serving: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("run never served")
	}
}

func TestShutdownEndsAnOpenStreamBeforeThePoolCloses(t *testing.T) {
	var rec recorder
	var passes atomic.Int32
	served := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	addr := freeAddr(t)
	p := testPlane(addr, &rec, &passes, served)
	// Like the event stream, the handler only ends when its request context does.
	p.handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		rec.add("stream returned")
	})
	done := make(chan error, 1)
	go func() { done <- run(ctx, p) }()
	awaitServe(t, served, done)
	// The client keeps the body open, so only the server side can end the request.
	resp, err := http.Get("http://" + addr + "/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second): // well inside the 5 s Shutdown timeout
		t.Fatal("run did not return while a stream was open")
	}
	ev := rec.list()
	if s, c := slices.Index(ev, "stream returned"), slices.Index(ev, "pool closed"); s < 0 || c < s {
		t.Fatalf("the stream handler must return before the pool closes: %q", ev)
	}
}

func TestShutdownStopsLoopsBeforeThePoolClosesAndThePortIsReusable(t *testing.T) {
	addr := freeAddr(t)
	for i := range 2 {
		var rec recorder
		var passes atomic.Int32
		served := make(chan struct{})
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- run(ctx, testPlane(addr, &rec, &passes, served)) }()
		select {
		case <-served:
		case err := <-done:
			t.Fatalf("run %d did not bind %s: %v", i+1, addr, err)
		case <-time.After(5 * time.Second):
			t.Fatalf("run %d never served", i+1)
		}
		resp, err := http.Get("http://" + addr + "/")
		if err != nil {
			t.Fatalf("run %d does not answer: %v", i+1, err)
		}
		resp.Body.Close()
		cancel()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		ev := rec.list()
		closed := slices.Index(ev, "pool closed")
		for _, loop := range []string{"reaper returned", "monitor returned"} {
			if j := slices.Index(ev, loop); j < 0 || closed < j {
				t.Fatalf("%s must come before the pool closes: %q", loop, ev)
			}
		}
	}
}
