package service

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/microverse/order-management/order-service/internal/model"
)

// Fakes implement the interfaces OrderService declares. Because the service
// depends on interfaces, no database or network is needed to test it.

type fakeRepo struct {
	byKey  map[string]*model.Order
	hashes map[string]string
	orders map[int64]*model.Order
	nextID int64
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{byKey: map[string]*model.Order{}, hashes: map[string]string{}, orders: map[int64]*model.Order{}, nextID: 1}
}

func (f *fakeRepo) FindByIdempotencyKey(_ context.Context, _ int64, key string) (*model.Order, string, error) {
	return f.byKey[key], f.hashes[key], nil
}

func (f *fakeRepo) CreateWithOutbox(_ context.Context, p model.CreateOrderParams) (*model.Order, bool, error) {
	p.Order.ID = f.nextID
	p.Order.Version = 1
	f.nextID++
	f.orders[p.Order.ID] = p.Order
	f.byKey[p.IdempotencyKey] = p.Order
	f.hashes[p.IdempotencyKey] = p.RequestHash
	return p.Order, false, nil
}

func (f *fakeRepo) GetByID(_ context.Context, id int64) (*model.Order, error) {
	if o, ok := f.orders[id]; ok {
		return o, nil
	}
	return nil, model.ErrNotFound
}

func (f *fakeRepo) ListByUser(context.Context, int64, int, int64) ([]model.Order, error) { return nil, nil }

func (f *fakeRepo) UpdateStatus(_ context.Context, o *model.Order, to model.Status, _ string) error {
	o.Status = to
	o.Version++
	return nil
}

type fakeUsers struct {
	calls int
	err   error
}

func (f *fakeUsers) GetUser(_ context.Context, id int64) (*model.Customer, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return &model.Customer{ID: id, Status: "active"}, nil
}

func newService(users *fakeUsers) (*OrderService, *fakeRepo) {
	repo := newFakeRepo()
	return NewOrderService(repo, users, slog.New(slog.NewTextHandler(io.Discard, nil))), repo
}

var input = CreateOrderInput{
	UserID: 42, IdempotencyKey: "7f3a", Currency: "usd",
	Items: []model.Item{{ProductID: "sku-1", Quantity: 2, UnitPriceCents: 1500}},
}

func TestCreateOrderIsIdempotent(t *testing.T) {
	users := &fakeUsers{}
	svc, _ := newService(users)

	first, replayed, err := svc.CreateOrder(context.Background(), input)
	if err != nil || replayed {
		t.Fatalf("first create: replayed=%v err=%v", replayed, err)
	}
	if first.TotalCents != 3000 || first.Currency != "USD" {
		t.Fatalf("unexpected order: %+v", first)
	}

	second, replayed, err := svc.CreateOrder(context.Background(), input)
	if err != nil || !replayed || second.ID != first.ID {
		t.Fatalf("retry: id=%d replayed=%v err=%v, want id=%d replayed=true", second.ID, replayed, err, first.ID)
	}
	if users.calls != 1 {
		t.Fatalf("user-service called %d times; a replay should not call dependencies", users.calls)
	}

	changed := input
	changed.Items = []model.Item{{ProductID: "sku-2", Quantity: 1, UnitPriceCents: 100}}
	if _, _, err := svc.CreateOrder(context.Background(), changed); !errors.Is(err, model.ErrIdempotencyMismatch) {
		t.Fatalf("reused key with new body: err=%v, want ErrIdempotencyMismatch", err)
	}
}

func TestCreateOrderDependencyFailure(t *testing.T) {
	svc, _ := newService(&fakeUsers{err: errors.New("connection refused")})
	_, _, err := svc.CreateOrder(context.Background(), input)
	if !errors.Is(err, model.ErrDependencyUnavailable) {
		t.Fatalf("err=%v, want ErrDependencyUnavailable", err)
	}
}

func TestCancelRules(t *testing.T) {
	svc, repo := newService(&fakeUsers{})
	o, _, _ := svc.CreateOrder(context.Background(), input)

	if _, err := svc.CancelOrder(context.Background(), 7, o.ID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("other user's order: err=%v, want ErrNotFound", err)
	}

	repo.orders[o.ID].Status = model.StatusShipped
	if _, err := svc.CancelOrder(context.Background(), 42, o.ID); !errors.Is(err, model.ErrInvalidTransition) {
		t.Fatalf("cancel shipped order: err=%v, want ErrInvalidTransition", err)
	}
}
