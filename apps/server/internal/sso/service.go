package sso

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	pb "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitycrypto"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Closed service errors are mapped by the integration HTTP adapter.
var (
	ErrDenied    = errors.New("identity access denied")
	ErrChanged   = errors.New("identity configuration changed")
	ErrNotLinked = errors.New("identity not linked")
	ErrInvalid   = errors.New("invalid identity request")
)

// IssueRequest never carries local authority or global profile privileges.
type IssueRequest struct {
	UserID, WorkspaceID, ConnectionID uuid.UUID
	Authority                         identitypolicy.Authority
	ExpiresAt, AuthenticatedAt        time.Time
}

// Issued is returned only after the caller commits its issuing transaction.
type Issued struct {
	Principal identitypolicy.Principal
	Tokens    *pb.AuthTokens
}

// SessionIssuer signs tokens for an already inserted scoped session; it must not commit.
type SessionIssuer interface {
	IssueIdentityTokens(context.Context, *sqlc.Queries, sqlc.Session, string) (*pb.AuthTokens, error)
}

// Service owns corporate flows. Root wiring supplies the existing session token broker.
type Service struct {
	DB       *db.DB
	Keys     *identitycrypto.Keyring
	Protocol *OIDC
	Edition  identitypolicy.EntitlementConfig
	Sessions SessionIssuer
	Now      func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}
func (s *Service) loader(q *sqlc.Queries) *identitypolicy.SQLLoader {
	return identitypolicy.NewSQLLoader(q, s.Edition)
}

func (s *Service) boundaryNow(ctx context.Context, q *sqlc.Queries) (time.Time, error) {
	databaseNow, err := q.IdentityDatabaseNow(ctx)
	if err != nil {
		return time.Time{}, err
	}
	now := s.now()
	if databaseNow.After(now) {
		now = databaseNow
	}
	return now, nil
}

// CheckDecision uses the conservative application/database clock after the caller's locks.
func (s *Service) CheckDecision(ctx context.Context, q *sqlc.Queries, st identitypolicy.State, op identitypolicy.Operation) (identitypolicy.Decision, error) {
	now, err := s.boundaryNow(ctx, q)
	if err != nil {
		return identitypolicy.Decision{}, err
	}
	return identitypolicy.Evaluate(now, st, op), nil
}

// AccessError retains a closed policy decision for the root wire-error adapter.
// errors.Is(err, ErrDenied) remains true; dependency failures are never wrapped.
type AccessError struct{ Decision identitypolicy.Decision }

func (e *AccessError) Error() string { return "identity access denied: " + string(e.Decision.Reason) }
func (*AccessError) Unwrap() error   { return ErrDenied }
func accessDecision(d identitypolicy.Decision) error {
	if !d.Allowed {
		return &AccessError{Decision: d}
	}
	return nil
}
func denied(reason identitypolicy.Reason) error {
	return &AccessError{Decision: identitypolicy.Decision{Reason: reason}}
}
func classified(err error, fallback error) error {
	if err != nil && !db.IsNotFound(err) {
		return err
	}
	return fallback
}
func (s *Service) require(ctx context.Context, q *sqlc.Queries, st identitypolicy.State, op identitypolicy.Operation) error {
	d, err := s.CheckDecision(ctx, q, st, op)
	if err != nil {
		return err
	}
	return accessDecision(d)
}
func (s *Service) live(ctx context.Context, q *sqlc.Queries, p identitypolicy.Principal) error {
	now, err := s.boundaryNow(ctx, q)
	if err != nil {
		return err
	}
	return accessDecision(identitypolicy.CheckSession(now, p))
}
func (s *Service) requireTest(ctx context.Context, q *sqlc.Queries, st identitypolicy.State) error {
	st.Policy.Mode = identitypolicy.Optional
	st.Directory.Required = false
	return s.require(ctx, q, st, identitypolicy.ManageSSO)
}

// Owner tests retain the upstream authentication deadline through every commit.
// Completion and tested timestamps record workflow progress, never a new proof.
func (s *Service) requireOwnerTestProof(ctx context.Context, q *sqlc.Queries, proof Proof) error {
	now, err := s.boundaryNow(ctx, q)
	if err != nil {
		return err
	}
	if proof.AuthenticatedAt.IsZero() || proof.AuthenticatedAt.After(now) || !now.Before(proof.AuthenticatedAt.Add(identitypolicy.ManagementMaxAge)) {
		return denied(identitypolicy.RecentAuthRequired)
	}
	return nil
}
func (s *Service) requireEnforcement(ctx context.Context, q *sqlc.Queries, st identitypolicy.State) error {
	now, err := s.boundaryNow(ctx, q)
	if err != nil {
		return err
	}
	return accessDecision(identitypolicy.EvaluateEnforcement(now, st))
}

type flowPayload struct {
	Verifier, Browser, Authorization string
	Versions                         identitypolicy.Versions
	ScopedStepUp                     *scopedStepUp
}

// A scoped reauthentication is bound to the original identity and absolute deadline.
type scopedStepUp struct {
	SessionID, UserID, WorkspaceID, ConnectionID, IdentityID uuid.UUID
	Issuer, Subject                                          string
	SessionExpiresAt                                         time.Time
}

func (s *Service) stepUpBinding(ctx context.Context, q *sqlc.Queries, st identitypolicy.State, c sqlc.WorkspaceIdentityConnection) (*scopedStepUp, int64, error) {
	p := st.Principal
	if err := s.live(ctx, q, p); err != nil {
		return nil, 0, err
	}
	if p.Guest || p.Bot || (p.Authority != identitypolicy.LocalAccount && p.Authority != identitypolicy.WorkspaceSSO) {
		return nil, 0, denied(identitypolicy.ScopeDenied)
	}
	if _, _, err := s.member(ctx, q, st.WorkspaceID, p.UserID, false); err != nil {
		return nil, 0, err
	}
	if p.Authority == identitypolicy.LocalAccount {
		return nil, 0, nil
	}
	if p.WorkspaceID != st.WorkspaceID || p.ConnectionID != c.ID || c.WorkspaceID != st.WorkspaceID || c.Status != "active" || c.DisabledAt != nil || c.TestedVersion == nil || *c.TestedVersion != c.Version {
		return nil, 0, denied(identitypolicy.ScopeDenied)
	}
	identity, err := q.FindUserExternalIdentity(ctx, sqlc.FindUserExternalIdentityParams{WorkspaceID: st.WorkspaceID, ConnectionID: c.ID, UserID: p.UserID})
	if err != nil || identity.Status != "active" || identity.Issuer != c.Issuer {
		return nil, 0, classified(err, ErrNotLinked)
	}
	return &scopedStepUp{SessionID: p.SessionID, UserID: p.UserID, WorkspaceID: st.WorkspaceID, ConnectionID: c.ID, IdentityID: identity.ID, Issuer: identity.Issuer, Subject: identity.Subject, SessionExpiresAt: p.ExpiresAt}, identity.Version, nil
}

func sameScopedStepUp(a, b *scopedStepUp) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.SessionID == b.SessionID && a.UserID == b.UserID && a.WorkspaceID == b.WorkspaceID && a.ConnectionID == b.ConnectionID && a.IdentityID == b.IdentityID && a.Issuer == b.Issuer && a.Subject == b.Subject && a.SessionExpiresAt.Equal(b.SessionExpiresAt)
}

type completion struct {
	Proof              Proof
	IdentityID, UserID uuid.UUID
	Versions           identitypolicy.Versions
	// Link: the proof's subject is not linked yet. Only finish creates the identity, after the
	// client that began the flow proved itself (native ticket + PKCE verifier, web flow
	// cookie): whoever merely opened a start URL must not bind their subject to the initiator.
	Link bool
}

// BeginResult includes the private browser cookie separately from the wire response.
type BeginResult struct {
	Response *pb.SSOBeginResponse
	Browser  string
}

// CallbackResult contains only fixed local completion routing or a native completion ticket.
type CallbackResult struct {
	FlowID uuid.UUID
	Native bool
	Ticket string
}

// Result either adds workspace assurance to the initiating session or issues scoped tokens.
type Result struct {
	Tokens    *pb.AuthTokens
	Assurance *pb.WorkspaceAssurance
	Tested    bool
}

func binding(t sqlc.IdentityLoginTransaction, purpose string) identitycrypto.Binding {
	return identitycrypto.Binding{Purpose: purpose, WorkspaceID: t.WorkspaceID, RecordID: t.ID, Version: t.ConnectionVersion}
}
func (s *Service) seal(t sqlc.IdentityLoginTransaction, purpose string, v any) ([]byte, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return s.Keys.Seal(binding(t, purpose), b)
}
func (s *Service) open(t sqlc.IdentityLoginTransaction, purpose string, box []byte, v any) error {
	b, err := s.Keys.Open(binding(t, purpose), box)
	if err != nil {
		return ErrInvalid
	}
	if json.Unmarshal(b, v) != nil {
		return ErrInvalid
	}
	return nil
}
func secretBinding(c sqlc.WorkspaceIdentityConnection) identitycrypto.Binding {
	return identitycrypto.Binding{Purpose: "sso-client-secret", WorkspaceID: c.WorkspaceID, RecordID: c.ID, Version: c.Version}
}

func (s *Service) workspace(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) (sqlc.WorkspaceIdentityPolicy, identitypolicy.Grant, error) {
	w, err := q.LockOAuthWorkspace(ctx, ws)
	if err != nil {
		return sqlc.WorkspaceIdentityPolicy{}, identitypolicy.Grant{}, classified(err, denied(identitypolicy.ScopeDenied))
	}
	if w.SuspendedAt != nil {
		return sqlc.WorkspaceIdentityPolicy{}, identitypolicy.Grant{}, denied(identitypolicy.WorkspaceSuspended)
	}
	if _, err = q.EnsureIdentityPolicy(ctx, ws); err != nil {
		return sqlc.WorkspaceIdentityPolicy{}, identitypolicy.Grant{}, err
	}
	policy, err := q.GetIdentityPolicyForUpdate(ctx, ws)
	if err != nil {
		return policy, identitypolicy.Grant{}, err
	}
	grant, err := s.grant(ctx, q, ws, identitypolicy.SSO)
	return policy, grant, err
}
func (s *Service) grant(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, f identitypolicy.Feature) (identitypolicy.Grant, error) {
	now, clockErr := s.boundaryNow(ctx, q)
	if clockErr != nil {
		return identitypolicy.Grant{}, clockErr
	}
	row, err := q.GetIdentityGrant(ctx, sqlc.GetIdentityGrantParams{WorkspaceID: ws, Feature: string(f)})
	if err != nil {
		return identitypolicy.Grant{}, classified(err, denied(identitypolicy.EntitlementRequired))
	}
	plan, err := q.GetWorkspacePlan(ctx, ws)
	if err != nil && !db.IsNotFound(err) {
		return identitypolicy.Grant{}, err
	}
	g := identitypolicy.Grant{WorkspaceID: ws, Feature: f, Source: row.Source, Enabled: row.Enabled, Revoked: row.RevokedAt != nil, Version: row.Version, PlanEligible: s.Edition.Eligible(ws, row.Source, identitypolicy.PlanGrantsIdentity(plan.Plan, plan.Limits, plan.ValidUntil, now))}
	if row.ValidUntil != nil {
		g.ValidUntil = *row.ValidUntil
	}
	if row.Source == "cloud_business" && plan.ValidUntil != nil {
		g.ValidUntil = minTime(g.ValidUntil, *plan.ValidUntil)
	}
	if err := accessDecision(identitypolicy.RequireEntitlement(now, ws, g, f)); err != nil {
		return g, err
	}
	return g, nil
}
func minTime(a, b time.Time) time.Time {
	if a.IsZero() || b.Before(a) {
		return b
	}
	return a
}
func (s *Service) state(ctx context.Context, q *sqlc.Queries, p identitypolicy.Principal, ws uuid.UUID) (identitypolicy.State, error) {
	if _, err := q.LockIdentityBoundary(ctx, sqlc.LockIdentityBoundaryParams{WorkspaceID: ws, UserID: p.UserID, SessionID: p.SessionID}); err != nil {
		return identitypolicy.State{}, classified(err, denied(identitypolicy.InvalidSession))
	}
	st, err := s.loader(q).LoadIdentityState(ctx, p.SessionID, p.UserID, ws)
	if err != nil {
		return st, err
	}
	return st, nil
}

// RequireFeature resolves a positive current grant within the caller's workspace transaction.
func (s *Service) RequireFeature(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, f identitypolicy.Feature) (identitypolicy.Grant, error) {
	return s.grant(ctx, q, ws, f)
}
func (s *Service) member(ctx context.Context, q *sqlc.Queries, ws, user uuid.UUID, bootstrap bool) (int64, time.Time, error) {
	now, clockErr := s.boundaryNow(ctx, q)
	if clockErr != nil {
		return 0, time.Time{}, clockErr
	}
	m, err := q.GetIdentityMemberEligibility(ctx, sqlc.GetIdentityMemberEligibilityParams{WorkspaceID: ws, UserID: user})
	if err != nil {
		return 0, time.Time{}, classified(err, denied(identitypolicy.MembershipRequired))
	}
	if m.UserDenied {
		return 0, time.Time{}, denied(identitypolicy.InvalidSession)
	}
	if !m.Member {
		return 0, time.Time{}, denied(identitypolicy.MembershipRequired)
	}
	if m.Suspended {
		return 0, time.Time{}, denied(identitypolicy.MembershipSuspended)
	}
	until := now.Add(time.Hour)
	if m.DirectoryRequired && !bootstrap {
		if _, err = s.grant(ctx, q, ws, identitypolicy.DirectorySync); err != nil {
			return 0, time.Time{}, err
		}
		if !m.DirectoryActive || !now.Before(m.DirectoryValidUntil) {
			return 0, time.Time{}, denied(identitypolicy.DirectoryStale)
		}
		until = minTime(until, m.DirectoryValidUntil)
	}
	return m.AccessVersion, until, nil
}
func purpose(p pb.SSOFlowPurpose) string {
	switch p {
	case pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LOGIN:
		return "login"
	case pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_STEP_UP:
		return "step_up"
	case pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_LINK:
		return "link"
	case pb.SSOFlowPurpose_SSO_FLOW_PURPOSE_TEST:
		return "test"
	}
	return ""
}

// Begin records immutable workspace/initiator and encrypted version snapshots.
func (s *Service) Begin(ctx context.Context, p identitypolicy.Principal, ws uuid.UUID, req *pb.SSOBeginRequest) (BeginResult, error) {
	var out BeginResult
	if s == nil || s.DB == nil || s.Keys == nil || s.Protocol == nil || req == nil {
		return out, ErrInvalid
	}
	what := purpose(req.Purpose)
	native := req.ClientKind == pb.SSOClientKind_SSO_CLIENT_KIND_DESKTOP
	if what == "" || (!native && req.ClientKind != pb.SSOClientKind_SSO_CLIENT_KIND_WEB) {
		return out, ErrInvalid
	}
	if native {
		raw, err := base64.RawURLEncoding.DecodeString(req.DesktopChallenge)
		if err != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != req.DesktopChallenge {
			return out, ErrInvalid
		}
	} else if req.DesktopChallenge != "" {
		return out, ErrInvalid
	}
	state, err := identitycrypto.Secret()
	if err != nil {
		return out, err
	}
	nonce, err := identitycrypto.Secret()
	if err != nil {
		return out, err
	}
	verifier, err := identitycrypto.Secret()
	if err != nil {
		return out, err
	}
	browser, err := identitycrypto.Secret()
	if err != nil {
		return out, err
	}
	start, err := identitycrypto.Secret()
	if err != nil {
		return out, err
	}
	err = s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		policy, _, err := s.workspace(ctx, q, ws)
		if err != nil {
			return err
		}
		c, err := s.flowConnection(ctx, q, ws, what, p.UserID)
		if err != nil || c.DisabledAt != nil || (what != "test" && what != "link" && (c.Status != "active" || c.TestedVersion == nil || *c.TestedVersion != c.Version)) {
			return classified(err, denied(identitypolicy.SSORequired))
		}
		versions := identitypolicy.Versions{Policy: policy.Version, Entitlement: policy.EntitlementVersion, Connection: c.Version}
		var session, user *uuid.UUID
		var scoped *scopedStepUp
		if what != "login" {
			st, err := s.state(ctx, q, p, ws)
			if err != nil {
				return err
			}
			op := identitypolicy.BootstrapLink
			if what == "test" {
				op = identitypolicy.ManageSSO
			}
			if what == "step_up" {
				scoped, versions.Identity, err = s.stepUpBinding(ctx, q, st, c)
				if err != nil {
					return err
				}
			} else if what == "test" {
				if err := s.requireTest(ctx, q, st); err != nil {
					return err
				}
			} else if err := s.require(ctx, q, st, op); err != nil {
				return err
			}
			versions.Access = st.AccessVersion
			versions.Session = st.Principal.Version
			session = &p.SessionID
			user = &p.UserID
		}
		id, err := q.ReserveIdentityID(ctx)
		if err != nil {
			return err
		}
		t := sqlc.IdentityLoginTransaction{ID: id, WorkspaceID: ws, ConnectionID: c.ID, ConnectionVersion: c.Version}
		auth, err := s.Protocol.Authorization(ctx, c, state, nonce, verifier)
		if err != nil {
			return err
		}
		encrypted, err := s.seal(t, "sso-pending", flowPayload{Verifier: verifier, Browser: browser, Authorization: auth, Versions: versions, ScopedStepUp: scoped})
		if err != nil {
			return err
		}
		var challenge *string
		var startHash []byte
		if native {
			challenge = &req.DesktopChallenge
			startHash = identitycrypto.Hash(start)
		}
		databaseNow, err := q.IdentityDatabaseNow(ctx)
		if err != nil {
			return err
		}
		expires := databaseNow.Add(5 * time.Minute)
		if scoped != nil {
			expires = minTime(expires, scoped.SessionExpiresAt)
		}
		_, err = q.CreateIdentityLoginTransaction(ctx, sqlc.CreateIdentityLoginTransactionParams{ID: &id, WorkspaceID: ws, ConnectionID: c.ID, ConnectionVersion: c.Version, Purpose: what, SessionID: session, UserID: user, StateHash: identitycrypto.Hash(state), BrowserHash: identitycrypto.Hash(browser), NonceHash: identitycrypto.Hash(nonce), VerifierBox: encrypted, ReturnUri: "/sso/complete", NativeChallenge: challenge, BrowserStartHash: startHash, ExpiresAt: expires})
		if err != nil {
			return err
		}
		out = BeginResult{Response: &pb.SSOBeginResponse{FlowId: id.String(), ExpiresAt: timestamppb.New(expires)}, Browser: browser}
		if native {
			out.Response.BrowserStartUrl = s.Protocol.Origin + "/api/auth/sso/browser-start?handle=" + start
			out.Browser = ""
		} else {
			out.Response.AuthorizationUrl = auth
		}
		return nil
	})
	return out, err
}

// flowConnection picks the connection a flow authenticates against. Login and step-up use
// the active connection. Test uses the newest draft/tested revision (the one about to be
// activated), else the active one. Link prefers the active connection, so members can link
// while an owner prepares a new draft; it falls back to the newest draft/tested revision only
// when no usable active connection exists or the user is already linked to the active one
// (an owner linking ahead to test a replacement).
func (s *Service) flowConnection(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, what string, user uuid.UUID) (sqlc.WorkspaceIdentityConnection, error) {
	active, err := q.GetActiveIdentityConnection(ctx, ws)
	if err != nil && !db.IsNotFound(err) {
		return active, err
	}
	if what != "test" && what != "link" {
		return active, err
	}
	usable := err == nil && active.Status == "active" && active.DisabledAt == nil && active.TestedVersion != nil && *active.TestedVersion == active.Version
	if what == "link" && usable {
		linked, e := q.FindUserExternalIdentity(ctx, sqlc.FindUserExternalIdentityParams{WorkspaceID: ws, ConnectionID: active.ID, UserID: user})
		if e != nil && !db.IsNotFound(e) {
			return active, e
		}
		if e != nil || linked.Status != "active" {
			return active, nil
		}
	}
	connections, e := q.ListIdentityConnections(ctx, ws)
	if e != nil {
		return active, e
	}
	for i := len(connections) - 1; i >= 0; i-- {
		if connections[i].Status == "draft" || connections[i].Status == "tested" {
			return connections[i], nil
		}
	}
	return active, err
}

// BrowserStart consumes the native bootstrap exactly once without issuing credentials.
func (s *Service) BrowserStart(ctx context.Context, handle string) (uuid.UUID, string, string, error) {
	t, err := s.DB.Q.ConsumeIdentityBrowserStart(ctx, identitycrypto.Hash(handle))
	if err != nil {
		return uuid.Nil, "", "", classified(err, ErrInvalid)
	}
	var payload flowPayload
	if s.open(t, "sso-pending", t.VerifierBox, &payload) != nil {
		return uuid.Nil, "", "", ErrInvalid
	}
	return t.ID, payload.Browser, payload.Authorization, nil
}

func (s *Service) validateFlow(ctx context.Context, q *sqlc.Queries, t sqlc.IdentityLoginTransaction, payload flowPayload) (sqlc.WorkspaceIdentityConnection, error) {
	policy, _, err := s.workspace(ctx, q, t.WorkspaceID)
	if err != nil {
		return sqlc.WorkspaceIdentityConnection{}, err
	}
	c, err := q.GetIdentityConnectionForUpdate(ctx, sqlc.GetIdentityConnectionForUpdateParams{WorkspaceID: t.WorkspaceID, ID: t.ConnectionID})
	if err != nil || c.Version != t.ConnectionVersion || c.DisabledAt != nil || (t.Purpose != "test" && t.Purpose != "link" && c.Status != "active") {
		return c, classified(err, ErrChanged)
	}
	now, clockErr := s.boundaryNow(ctx, q)
	if clockErr != nil {
		return sqlc.WorkspaceIdentityConnection{}, clockErr
	}
	if !now.Before(t.ExpiresAt) || policy.Version != payload.Versions.Policy || policy.EntitlementVersion != payload.Versions.Entitlement {
		return sqlc.WorkspaceIdentityConnection{}, ErrChanged
	}
	if t.UserID != nil {
		p := identitypolicy.Principal{UserID: *t.UserID, SessionID: *t.SessionID}
		st, err := s.state(ctx, q, p, t.WorkspaceID)
		if err != nil {
			return c, err
		}
		if st.Principal.Version != payload.Versions.Session || st.AccessVersion != payload.Versions.Access {
			return c, ErrChanged
		}
		if t.Purpose == "step_up" {
			scoped, version, err := s.stepUpBinding(ctx, q, st, c)
			if err != nil {
				return c, err
			}
			if !sameScopedStepUp(scoped, payload.ScopedStepUp) || version != payload.Versions.Identity {
				return c, ErrChanged
			}
		} else {
			op := identitypolicy.BootstrapLink
			if t.Purpose == "test" {
				op = identitypolicy.ManageSSO
			}
			if t.Purpose == "test" {
				if err := s.requireTest(ctx, q, st); err != nil {
					return c, err
				}
			} else if err := s.require(ctx, q, st, op); err != nil {
				return c, err
			}
		}
	}
	return c, nil
}

// Callback consumes upstream state before exchange, then stores only a sealed pending proof.
func (s *Service) Callback(ctx context.Context, connection uuid.UUID, state, browser, code string) (CallbackResult, error) {
	var result CallbackResult
	t, err := s.DB.Q.GetIdentityLoginTransactionByState(ctx, identitycrypto.Hash(state))
	if err != nil || t.ConnectionID != connection || !identitycrypto.EqualHash(browser, t.BrowserHash) {
		return result, classified(err, ErrInvalid)
	}
	var payload flowPayload
	if s.open(t, "sso-pending", t.VerifierBox, &payload) != nil {
		return result, ErrInvalid
	}
	var c sqlc.WorkspaceIdentityConnection
	err = s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		c, err = s.validateFlow(ctx, q, t, payload)
		if err != nil {
			return err
		}
		t, err = q.ConsumeIdentityLoginTransaction(ctx, sqlc.ConsumeIdentityLoginTransactionParams{StateHash: identitycrypto.Hash(state), BrowserHash: identitycrypto.Hash(browser), ConnectionID: connection, ConnectionVersion: t.ConnectionVersion})
		return err
	})
	if err != nil {
		return result, classified(err, ErrInvalid)
	}
	secret := ""
	if len(c.ClientSecretBox) > 0 {
		raw, e := s.Keys.Open(secretBinding(c), c.ClientSecretBox)
		if e != nil {
			return result, ErrInvalid
		}
		secret = string(raw)
	}
	proof, err := s.Protocol.Exchange(ctx, c, secret, code, payload.Verifier, t.NonceHash)
	if errors.Is(err, ErrAuthTimeMissing) {
		// Actionable for the owner (connection test included): the IdP must emit auth_time.
		if _, e := s.DB.Q.CreateIdentityAudit(ctx, sqlc.CreateIdentityAuditParams{WorkspaceID: t.WorkspaceID, ActorID: t.UserID, Action: "auth_time_missing", TargetID: &c.ID, Outcome: "denied"}); e != nil {
			return result, e
		}
	}
	if err != nil {
		return result, err
	}
	err = s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := s.validateFlow(ctx, q, t, payload); err != nil {
			return err
		}
		done := completion{Proof: proof, Versions: payload.Versions}
		if t.Purpose == "test" {
			if err := s.requireOwnerTestProof(ctx, q, proof); err != nil {
				return err
			}
			done.UserID = *t.UserID
			linked, err := q.FindExternalIdentity(ctx, sqlc.FindExternalIdentityParams{WorkspaceID: t.WorkspaceID, ConnectionID: t.ConnectionID, Issuer: proof.Issuer, Subject: proof.Subject})
			if err != nil || linked.UserID != *t.UserID || linked.Status != "active" {
				return classified(err, ErrNotLinked)
			}
			done.IdentityID = linked.ID
			done.Versions.Identity = linked.Version
		} else {
			identity, err := q.FindExternalIdentity(ctx, sqlc.FindExternalIdentityParams{WorkspaceID: t.WorkspaceID, ConnectionID: t.ConnectionID, Issuer: proof.Issuer, Subject: proof.Subject})
			if db.IsNotFound(err) && t.Purpose == "link" && t.UserID != nil {
				access, _, err := s.member(ctx, q, t.WorkspaceID, *t.UserID, true)
				if err != nil {
					return err
				}
				done.UserID = *t.UserID
				done.Versions.Access = access
				done.Link = true
				return s.complete(ctx, q, t, done, &result)
			}
			if err != nil || identity.Status != "active" {
				return classified(err, ErrNotLinked)
			}
			if t.UserID != nil && identity.UserID != *t.UserID {
				return denied(identitypolicy.ScopeDenied)
			}
			if scoped := payload.ScopedStepUp; scoped != nil && (identity.ID != scoped.IdentityID || identity.Version != payload.Versions.Identity || proof.Issuer != scoped.Issuer || proof.Subject != scoped.Subject) {
				return ErrChanged
			}
			access, _, err := s.member(ctx, q, t.WorkspaceID, identity.UserID, t.Purpose == "link")
			if err != nil {
				return err
			}
			done.UserID = identity.UserID
			done.IdentityID = identity.ID
			done.Versions.Access = access
			done.Versions.Identity = identity.Version
		}
		return s.complete(ctx, q, t, done, &result)
	})
	return result, err
}

// complete seals the verified callback result for finish/exchange and mints the native ticket.
func (s *Service) complete(ctx context.Context, q *sqlc.Queries, t sqlc.IdentityLoginTransaction, done completion, result *CallbackResult) error {
	encrypted, err := s.seal(t, "sso-completion", done)
	if err != nil {
		return err
	}
	if _, err = q.CompleteIdentityLoginTransaction(ctx, sqlc.CompleteIdentityLoginTransactionParams{ID: t.ID, ResultBox: encrypted}); err != nil {
		return err
	}
	*result = CallbackResult{FlowID: t.ID, Native: t.NativeChallenge != nil}
	if result.Native {
		ticket, err := identitycrypto.Secret()
		if err != nil {
			return err
		}
		databaseNow, err := q.IdentityDatabaseNow(ctx)
		if err != nil {
			return err
		}
		until := minTime(t.ExpiresAt, databaseNow.Add(time.Minute))
		_, err = q.CreateIdentityNativeHandoff(ctx, sqlc.CreateIdentityNativeHandoffParams{TransactionID: t.ID, TicketHash: identitycrypto.Hash(ticket), Challenge: *t.NativeChallenge, ExpiresAt: until, ResultBox: encrypted})
		if err != nil {
			return err
		}
		result.Ticket = ticket
	}
	return nil
}

// Finish and Exchange consume proof and all applicable policy epochs in the issuing transaction.
func (s *Service) Finish(ctx context.Context, flow uuid.UUID, browser string) (Result, error) {
	return s.finish(ctx, flow, browser, "", "")
}

// Exchange requires the native initiator's independent PKCE verifier.
func (s *Service) Exchange(ctx context.Context, flow uuid.UUID, ticket, verifier string) (Result, error) {
	return s.finish(ctx, flow, "", ticket, verifier)
}
func (s *Service) finish(ctx context.Context, flow uuid.UUID, browser, ticket, verifier string) (Result, error) {
	var out Result
	err := s.DB.Tx(ctx, func(q *sqlc.Queries) error {
		t, err := q.GetIdentityLoginTransactionByID(ctx, flow)
		if err != nil {
			return classified(err, ErrInvalid)
		}
		var pending flowPayload
		var done completion
		if s.open(t, "sso-pending", t.VerifierBox, &pending) != nil || s.open(t, "sso-completion", t.ResultBox, &done) != nil {
			return ErrInvalid
		}
		c, err := s.validateFlow(ctx, q, t, pending)
		if err != nil {
			return err
		}
		if t.NativeChallenge != nil {
			challenge, err := identitycrypto.S256(verifier)
			if err != nil {
				return ErrInvalid
			}
			if _, err = q.ConsumeIdentityNativeHandoff(ctx, sqlc.ConsumeIdentityNativeHandoffParams{TransactionID: flow, TicketHash: identitycrypto.Hash(ticket), Challenge: challenge}); err != nil {
				return classified(err, ErrInvalid)
			}
			// Mark the same flow finished as well, with its privately sealed browser secret.
			browser = pending.Browser
		} else if ticket != "" || verifier != "" {
			return ErrInvalid
		}
		if _, err = q.FinishIdentityLoginTransaction(ctx, sqlc.FinishIdentityLoginTransactionParams{ID: flow, BrowserHash: identitycrypto.Hash(browser)}); err != nil {
			return classified(err, ErrInvalid)
		}
		if t.Purpose == "test" {
			linked, err := q.GetExternalIdentity(ctx, sqlc.GetExternalIdentityParams{WorkspaceID: t.WorkspaceID, ID: done.IdentityID})
			if err != nil || t.UserID == nil || done.UserID != *t.UserID || linked.Status != "active" || linked.UserID != done.UserID || linked.Version != done.Versions.Identity || linked.ConnectionID != c.ID || linked.Issuer != c.Issuer || linked.Issuer != done.Proof.Issuer || linked.Subject != done.Proof.Subject {
				return classified(err, ErrChanged)
			}
			if err := s.requireOwnerTestProof(ctx, q, done.Proof); err != nil {
				return err
			}
			if _, err = q.MarkIdentityConnectionTested(ctx, sqlc.MarkIdentityConnectionTestedParams{WorkspaceID: c.WorkspaceID, ID: c.ID, Version: c.Version}); err != nil {
				return err
			}
			out.Tested = true
			if !done.Proof.PKCEAdvertised && c.Provider != "entra" {
				// Generic discovery omitted code_challenge_methods_supported: S256 was sent but the
				// provider never confirmed it. Recorded next to the test for the owner (ADR-0054).
				if err := Audit(ctx, q, c.WorkspaceID, t.UserID, "connection_tested_pkce_unadvertised", &c.ID); err != nil {
					return err
				}
			}
			return Audit(ctx, q, c.WorkspaceID, t.UserID, "connection_tested", &c.ID)
		}
		if done.Link {
			// The initiating client has just proven itself: only now bind the subject.
			if t.Purpose != "link" || t.UserID == nil || done.UserID != *t.UserID {
				return ErrInvalid
			}
			linked, err := q.FindExternalIdentity(ctx, sqlc.FindExternalIdentityParams{WorkspaceID: t.WorkspaceID, ConnectionID: t.ConnectionID, Issuer: done.Proof.Issuer, Subject: done.Proof.Subject})
			if db.IsNotFound(err) {
				linked, err = q.CreateExternalIdentity(ctx, sqlc.CreateExternalIdentityParams{WorkspaceID: t.WorkspaceID, ConnectionID: t.ConnectionID, UserID: done.UserID, Issuer: done.Proof.Issuer, Subject: done.Proof.Subject, Status: "active"})
				if err == nil {
					err = Audit(ctx, q, t.WorkspaceID, t.UserID, "identity_linked", &linked.ID)
				}
			}
			if err != nil || linked.Status != "active" {
				return classified(err, ErrNotLinked)
			}
			if linked.UserID != done.UserID {
				return denied(identitypolicy.ScopeDenied)
			}
			done.IdentityID, done.Versions.Identity = linked.ID, linked.Version
		}
		identity, err := q.GetExternalIdentity(ctx, sqlc.GetExternalIdentityParams{WorkspaceID: t.WorkspaceID, ID: done.IdentityID})
		if err != nil || identity.Status != "active" || identity.Version != done.Versions.Identity || identity.UserID != done.UserID {
			return classified(err, ErrChanged)
		}
		if scoped := pending.ScopedStepUp; scoped != nil && (done.UserID != scoped.UserID || identity.ID != scoped.IdentityID || identity.ConnectionID != scoped.ConnectionID || identity.Issuer != scoped.Issuer || identity.Subject != scoped.Subject || done.Proof.Issuer != scoped.Issuer || done.Proof.Subject != scoped.Subject) {
			return ErrChanged
		}
		if t.Purpose == "link" && c.Status != "active" {
			return Audit(ctx, q, t.WorkspaceID, &done.UserID, "draft_identity_linked", &done.IdentityID)
		}
		access, dirUntil, err := s.member(ctx, q, t.WorkspaceID, done.UserID, false)
		if err != nil {
			return err
		}
		if access != done.Versions.Access {
			return ErrChanged
		}
		g, err := s.grant(ctx, q, t.WorkspaceID, identitypolicy.SSO)
		if err != nil {
			return err
		}
		now, err := s.boundaryNow(ctx, q)
		if err != nil {
			return err
		}
		until := minTime(done.Proof.AuthenticatedAt.Add(time.Hour), dirUntil)
		until = minTime(until, identitypolicy.RequireEntitlement(now, t.WorkspaceID, g, identitypolicy.SSO).ValidUntil)
		if !now.Before(until) {
			return denied(identitypolicy.SSORequired)
		}
		var principal identitypolicy.Principal
		if t.SessionID != nil {
			st, err := s.state(ctx, q, identitypolicy.Principal{SessionID: *t.SessionID, UserID: done.UserID}, t.WorkspaceID)
			if err != nil {
				return err
			}
			principal = st.Principal
		} else {
			if s.Sessions == nil {
				return errors.New("identity session issuer unavailable")
			}
			issued, err := s.issue(ctx, q, IssueRequest{UserID: done.UserID, WorkspaceID: t.WorkspaceID, ConnectionID: t.ConnectionID, Authority: identitypolicy.WorkspaceSSO, ExpiresAt: until, AuthenticatedAt: done.Proof.AuthenticatedAt})
			if err != nil {
				return err
			}
			principal = issued.Principal
			out.Tokens = issued.Tokens
			if !identitypolicy.CheckSession(now, principal).Allowed || principal.Authority != identitypolicy.WorkspaceSSO || principal.UserID != done.UserID || principal.WorkspaceID != t.WorkspaceID || principal.ConnectionID != t.ConnectionID || principal.ExpiresAt.After(until) {
				return denied(identitypolicy.ScopeDenied)
			}
		}
		until = minTime(until, principal.ExpiresAt)
		_, err = q.UpsertWorkspaceAssurance(ctx, sqlc.UpsertWorkspaceAssuranceParams{SessionID: principal.SessionID, WorkspaceID: t.WorkspaceID, UserID: done.UserID, ConnectionID: t.ConnectionID, IdentityID: done.IdentityID, AuthenticatedAt: done.Proof.AuthenticatedAt, ValidUntil: until, PolicyVersion: done.Versions.Policy, AccessVersion: access, ConnectionVersion: c.Version, IdentityVersion: identity.Version, EntitlementVersion: done.Versions.Entitlement, SessionVersion: principal.Version})
		if err != nil {
			return err
		}
		final, err := s.loader(q).LoadIdentityState(ctx, principal.SessionID, principal.UserID, t.WorkspaceID)
		if err != nil {
			return err
		}
		if err = s.require(ctx, q, final, identitypolicy.WorkspaceRead); err != nil {
			return err
		}
		out.Assurance = &pb.WorkspaceAssurance{WorkspaceId: t.WorkspaceID.String(), AuthenticatedAt: timestamppb.New(done.Proof.AuthenticatedAt), ExpiresAt: timestamppb.New(until), PolicyVersion: uint64(max(done.Versions.Policy, 0)), ConnectionVersion: uint64(max(c.Version, 0))}
		return Audit(ctx, q, t.WorkspaceID, &done.UserID, "sso_completed", &t.ID)
	})
	if err != nil {
		return Result{}, err
	}
	return out, nil
}

func (s *Service) issue(ctx context.Context, q *sqlc.Queries, r IssueRequest) (Issued, error) {
	if s.Sessions == nil {
		return Issued{}, errors.New("identity session issuer unavailable")
	}
	refresh, err := identitycrypto.Secret()
	if err != nil {
		return Issued{}, err
	}
	var conn *uuid.UUID
	var at *time.Time
	switch r.Authority {
	case identitypolicy.WorkspaceSSO:
		conn = &r.ConnectionID
	case identitypolicy.Recovery:
		at = &r.AuthenticatedAt
	default:
		return Issued{}, denied(identitypolicy.ScopeDenied)
	}
	row, err := q.CreateScopedIdentitySession(ctx, sqlc.CreateScopedIdentitySessionParams{UserID: r.UserID, RefreshTokenHash: identitycrypto.Hash(refresh), ExpiresAt: r.ExpiresAt, AuthorityKind: string(r.Authority), AuthorityWorkspaceID: &r.WorkspaceID, AuthorityConnectionID: conn, RecoveryAuthenticatedAt: at})
	if err != nil {
		return Issued{}, err
	}
	tokens, err := s.Sessions.IssueIdentityTokens(ctx, q, row, refresh)
	if err != nil {
		return Issued{}, err
	}
	p := identitypolicy.Principal{UserID: row.UserID, SessionID: row.ID, Authority: identitypolicy.Authority(row.AuthorityKind), WorkspaceID: r.WorkspaceID, ConnectionID: r.ConnectionID, ExpiresAt: row.ExpiresAt, Version: row.AuthorityVersion}
	if at != nil {
		p.RecoveryAuthenticatedAt = *at
	}
	return Issued{Principal: p, Tokens: tokens}, nil
}

// Audit records only IDs and a closed action, never secrets or claims.
func Audit(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, actor *uuid.UUID, action string, target *uuid.UUID) error {
	_, err := q.CreateIdentityAudit(ctx, sqlc.CreateIdentityAuditParams{WorkspaceID: ws, ActorID: actor, Action: action, TargetID: target, Outcome: "changed"})
	return err
}

// Invalidate revokes workspace credentials and advances durable epochs in the caller's transaction.
// TouchIdentityAccess preserves manual suspension and its reason, including on AD re-enable.
func Invalidate(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, user *uuid.UUID, reason string) error {
	policy, err := q.EnsureIdentityPolicy(ctx, ws)
	if err != nil {
		return err
	}
	access := int64(0)
	if user != nil {
		a, e := q.TouchIdentityAccess(ctx, sqlc.TouchIdentityAccessParams{WorkspaceID: ws, UserID: *user})
		if e != nil {
			return e
		}
		access = a.Version
	} else {
		policy, err = q.TouchIdentityPolicy(ctx, ws)
		if err != nil {
			return err
		}
	}
	if _, err = q.RevokeWorkspaceAssurances(ctx, sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: ws, UserID: user}); err != nil {
		return err
	}
	if _, err = q.RevokeWorkspaceOAuthGrants(ctx, sqlc.RevokeWorkspaceOAuthGrantsParams{WorkspaceID: ws, UserID: user, Reason: &reason}); err != nil {
		return err
	}
	if _, err = q.RevokeScopedIdentitySessions(ctx, sqlc.RevokeScopedIdentitySessionsParams{WorkspaceID: &ws, UserID: user}); err != nil {
		return err
	}
	_, err = q.CreateIdentityInvalidation(ctx, sqlc.CreateIdentityInvalidationParams{WorkspaceID: ws, UserID: user, PolicyVersion: policy.Version, AccessVersion: access, Reason: reason})
	return err
}
