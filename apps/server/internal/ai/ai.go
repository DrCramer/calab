package ai

import (
	"context"
	"crypto/sha256"
	"errors"
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/sealbox"
	"github.com/calaba/calaba/server/internal/unfurl"
)

// DefaultModel is the model of a workspace that never saved its settings (owner, 22.10).
const DefaultModel = "gpt-6-astra"

// ChecksPerMinute limits «Проверить» per workspace (each call may cost the workspace money).
const ChecksPerMinute = 10

const (
	providerGPTunnel = "gptunnel"
	providerOpenAI   = "openai"
	maxModel         = 128
	maxBaseURL       = 500
	maxKey           = 512
	hintLen          = 4
	minKeyForHint    = 12 // shorter keys get no hint: 4 characters would be too much of them
)

var providerToDB = map[v1.AiProvider]string{
	v1.AiProvider_AI_PROVIDER_GPTUNNEL:          providerGPTunnel,
	v1.AiProvider_AI_PROVIDER_OPENAI_COMPATIBLE: providerOpenAI,
}

var providerFromDB = map[string]v1.AiProvider{
	providerGPTunnel: v1.AiProvider_AI_PROVIDER_GPTUNNEL,
	providerOpenAI:   v1.AiProvider_AI_PROVIDER_OPENAI_COMPATIBLE,
}

// Service serves /api/workspaces/{id}/ai.
type Service struct {
	db  *db.DB
	box *sealbox.Box
	// gptunnelURL is GPTUNNEL_AI_URL: the API root of GPTunneL (operator config, trusted).
	gptunnelURL string
	// trusted calls the configured GPTunneL; open calls user-given URLs (public addresses only).
	trusted, open *Chat
	// CheckLimit: per workspace (ChecksPerMinute); nil = unlimited (tests).
	CheckLimit *redisx.RateLimiter
	// fpKey keys the fingerprints of checked settings (state.go).
	fpKey []byte
}

// New wires the service. allow is the address policy of user-given base URLs (nil =
// unfurl.PublicAddr).
func New(d *db.DB, r rueidis.Client, secret []byte, gptunnelURL string, allow func(netip.Addr) bool) *Service {
	if allow == nil {
		allow = unfurl.PublicAddr
	}
	s := &Service{
		db: d, box: sealbox.New("calaba/workspace-ai-key/v1", secret), gptunnelURL: gptunnelURL,
		trusted: NewChat(nil), open: NewChat(allow),
	}
	fp := sha256.Sum256(append([]byte("calaba/workspace-ai-check/v1\x00"), secret...))
	s.fpKey = fp[:]
	if r != nil {
		s.CheckLimit = redisx.NewRateLimiter(r, "rl:ai-check:", ChecksPerMinute, ChecksPerMinute)
	}
	return s
}

// Routes registers the AI integration routes.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/workspaces/{id}/ai", wrap(httpx.HandlerFunc(s.get)))
	mux.Handle("PUT /api/workspaces/{id}/ai", wrap(httpx.HandlerFunc(s.put)))
	mux.Handle("POST /api/workspaces/{id}/ai/check", wrap(httpx.HandlerFunc(s.check)))
	mux.Handle("GET /api/workspaces/{id}/ai/status", wrap(httpx.HandlerFunc(s.status)))
}

func uid(r *http.Request) uuid.UUID { return auth.MustFromContext(r.Context()).UserID }

// manage resolves the workspace of the path for a MANAGE_INTEGRATIONS member, never a guest
// (ADR-0048; 404 for non-members).
func manage(r *http.Request) (uuid.UUID, error) {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return uuid.Nil, err
	}
	bits, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), wsID, uid(r))
	if errors.Is(err, perm.ErrNotMember) {
		return uuid.Nil, httpx.NotFound("workspace")
	}
	if err != nil {
		return uuid.Nil, err
	}
	if role == perm.RoleGuest || !bits.Has(perm.ManageIntegrations) {
		return uuid.Nil, httpx.Forbidden("MANAGE_INTEGRATIONS required")
	}
	return wsID, nil
}

func (s *Service) row(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID) (sqlc.WorkspaceAi, bool, error) {
	a, err := q.GetWorkspaceAi(ctx, wsID)
	if db.IsNotFound(err) {
		return sqlc.WorkspaceAi{WorkspaceID: wsID, Model: DefaultModel}, false, nil
	}
	return a, err == nil, err
}

func (s *Service) settingsPB(ctx context.Context, q *sqlc.Queries, a sqlc.WorkspaceAi, saved bool) (*v1.AiSettings, error) {
	out := &v1.AiSettings{Provider: providerFromDB[a.Provider], BaseUrl: a.BaseUrl, Model: a.Model, HasKey: len(a.KeyEnc) > 0}
	sv := stored{row: a, saved: saved}
	if len(a.KeyEnc) > 0 {
		p, err := s.box.Open(a.KeyEnc)
		if err != nil {
			return nil, err
		}
		sv.key = string(p)
	}
	st, c, err := s.stateOf(ctx, q, sv)
	if err != nil {
		return nil, err
	}
	out.State = st
	if c != nil {
		out.CheckedAt = timestamppb.New(c.CheckedAt)
		if !c.Ok {
			out.CheckError = c.Error
		}
	}
	if out.HasKey {
		out.KeyMask = "••••" + a.KeyHint
	}
	if saved {
		out.UpdatedAt = timestamppb.New(a.UpdatedAt)
		if a.UpdatedBy != nil {
			out.UpdatedBy = a.UpdatedBy.String()
		}
	}
	return out, nil
}

func (s *Service) get(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manage(r)
	if err != nil {
		return err
	}
	a, saved, err := s.row(r.Context(), s.db.Q, wsID)
	if err != nil {
		return err
	}
	pb, err := s.settingsPB(r.Context(), s.db.Q, a, saved)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.GetAiSettingsResponse{Settings: pb})
	return nil
}

// input is a validated form (PUT or check).
type input struct {
	provider, baseURL, model string
	key                      *string // nil = keep the stored key
}

type form interface {
	GetProvider() v1.AiProvider
	GetBaseUrl() string
	GetModel() string
}

func validate(req form, key *string) (input, error) {
	var in input
	var ok bool
	if in.provider, ok = providerToDB[req.GetProvider()]; !ok {
		return in, httpx.Validation("provider", "provider must be GPTunneL or OpenAI compatible")
	}
	if in.provider == providerOpenAI {
		u, err := NormalizeBaseURL(req.GetBaseUrl())
		if err != nil {
			return in, httpx.Validation("baseUrl", err.Error())
		}
		in.baseURL = u
	}
	in.model = strings.TrimSpace(req.GetModel())
	switch {
	case in.model == "":
		return in, httpx.Validation("model", "model is required")
	case utf8.RuneCountInString(in.model) > maxModel || !printable(in.model):
		return in, httpx.Validation("model", "model must be up to 128 printable characters")
	}
	if key != nil {
		k := strings.TrimSpace(*key)
		k = strings.TrimSpace(strings.TrimPrefix(k, "Bearer "))
		if len(k) > maxKey || !keyChars(k) {
			return in, httpx.Validation("apiKey", "API key must be up to 512 printable ASCII characters without spaces")
		}
		in.key = &k
	}
	return in, nil
}

// errBaseURL is a NormalizeBaseURL refusal (its text is the 422 message).
type errBaseURL string

func (e errBaseURL) Error() string { return string(e) }

// NormalizeBaseURL checks a user-given API root: an absolute http(s) URL without credentials,
// query or fragment, ≤ 500 characters; a trailing «/» and a pasted «/chat/completions» are dropped.
func NormalizeBaseURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errBaseURL("base URL is required")
	}
	if len(raw) > maxBaseURL {
		return "", errBaseURL("base URL must be up to 500 characters")
	}
	u, err := unfurl.CheckURL(raw)
	if err != nil || u.RawQuery != "" || u.Hostname() == "" {
		return "", errBaseURL("base URL must be an absolute http(s) URL, e.g. https://api.example.com/v1")
	}
	u.Path = strings.TrimRight(strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/chat/completions"), "/")
	u.RawPath = ""
	return u.String(), nil
}

func printable(s string) bool {
	for _, r := range s {
		if !unicode.IsPrint(r) {
			return false
		}
	}
	return true
}

func keyChars(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

func keyHint(k string) string {
	if len(k) < minKeyForHint {
		return ""
	}
	return k[len(k)-hintLen:]
}

// errKeyForOtherHost: a stored key is never reused for another provider or base URL.
var errKeyForOtherHost = httpx.Validation("apiKey", "enter the API key for this provider: the saved one belongs to another provider or base URL")

// sameTarget reports whether the stored key was entered for this provider and base URL.
func sameTarget(cur sqlc.WorkspaceAi, in input) bool {
	return cur.Provider == in.provider && cur.BaseUrl == in.baseURL
}

func (s *Service) put(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manage(r)
	if err != nil {
		return err
	}
	var req v1.PutAiSettingsRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	in, err := validate(&req, req.ApiKey)
	if err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	var saved sqlc.WorkspaceAi
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceAi(ctx, wsID); err != nil {
			return err
		}
		cur, _, err := s.row(ctx, q, wsID)
		if err != nil {
			return err
		}
		sealed, hint := []byte(nil), ""
		switch {
		case in.key == nil && len(cur.KeyEnc) > 0:
			if !sameTarget(cur, in) {
				return errKeyForOtherHost
			}
			sealed, hint = cur.KeyEnc, cur.KeyHint
		case in.key != nil && *in.key != "":
			if sealed, err = s.box.Seal([]byte(*in.key)); err != nil {
				return err
			}
			hint = keyHint(*in.key)
		}
		saved, err = q.PutWorkspaceAi(ctx, sqlc.PutWorkspaceAiParams{
			WorkspaceID: wsID, Provider: in.provider, BaseUrl: in.baseURL, Model: in.model,
			KeyEnc: sealed, KeyHint: hint, UpdatedBy: &me,
		})
		return err
	})
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "ai: settings saved", "workspace", wsID, "by", me, "provider", saved.Provider, "has_key", len(saved.KeyEnc) > 0)
	pb, err := s.settingsPB(ctx, s.db.Q, saved, true)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.PutAiSettingsResponse{Settings: pb})
	return nil
}

func (s *Service) check(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manage(r)
	if err != nil {
		return err
	}
	var req v1.CheckAiRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	in, err := validate(&req, req.ApiKey)
	if err != nil {
		return err
	}
	ctx := r.Context()
	key := ""
	if in.key != nil {
		key = *in.key
	} else {
		cur, _, err := s.row(ctx, s.db.Q, wsID)
		if err != nil {
			return err
		}
		if len(cur.KeyEnc) > 0 {
			if !sameTarget(cur, in) {
				return errKeyForOtherHost
			}
			p, err := s.box.Open(cur.KeyEnc)
			if err != nil {
				return err
			}
			key = string(p)
		}
	}
	if key == "" {
		return httpx.Validation("apiKey", "API key is required")
	}
	if s.CheckLimit != nil {
		if err := s.CheckLimit.Take(ctx, wsID.String()); err != nil {
			return err
		}
	}
	chat, base := s.open, in.baseURL
	if in.provider == providerGPTunnel {
		chat, base = s.trusted, s.gptunnelURL
	}
	res := chat.Hello(ctx, base, key, in.model)
	s.remember(ctx, wsID, in, key, res)
	st, err := s.State(ctx, wsID)
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "ai: check", "workspace", wsID, "by", uid(r), "provider", in.provider, "model", in.model,
		"ok", res.OK, "error", res.Error, "status", res.Status, "latency_ms", res.Latency.Milliseconds())
	httpx.Write(w, http.StatusOK, &v1.CheckAiResponse{
		Ok: res.OK, Reply: res.Reply, Error: res.Error, Message: res.Message,
		HttpStatus: uint32(max(res.Status, 0)), LatencyMs: uint32(max(res.Latency.Milliseconds(), 0)), //nolint:gosec // bounded by CheckTimeout
		State: st,
	})
	return nil
}
