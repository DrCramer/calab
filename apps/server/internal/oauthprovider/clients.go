package oauthprovider

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func clientType(t v1.OAuthClientType) string {
	switch t {
	case v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB:
		return "confidential_web"
	case v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE:
		return "public_native"
	case v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_SPA:
		return "public_spa"
	default:
		return ""
	}
}
func wireClientType(t string) v1.OAuthClientType {
	switch t {
	case "confidential_web":
		return v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB
	case "public_native":
		return v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE
	case "public_spa":
		return v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_SPA
	default:
		return v1.OAuthClientType_OAUTH_CLIENT_TYPE_UNSPECIFIED
	}
}

// validateClient reports the first problem as a field-level validation error
// (ADR-0102). Field names are the protojson names of CreateOAuthClientRequest; the
// messages are stable, and the desktop form keys its texts on them.
func validateClient(name, kind string, redirects, origins, scopes []string) error {
	if strings.TrimSpace(name) == "" || len([]rune(name)) > 100 {
		return httpx.Validation("name", "name must be 1 to 100 characters")
	}
	if kind == "" {
		return httpx.Validation("type", "unknown client type")
	}
	if len(redirects) == 0 {
		return httpx.Validation("redirectUris", "at least one redirect URI is required")
	}
	if len(redirects) > 10 {
		return httpx.Validation("redirectUris", "at most 10 redirect URIs")
	}
	seen := map[string]bool{}
	for _, r := range redirects {
		if _, problem := redirectProblem(r, kind); problem != "" {
			return httpx.Validation("redirectUris", problem)
		}
		if seen[r] {
			return httpx.Validation("redirectUris", "duplicate redirect URI")
		}
		seen[r] = true
	}
	if kind != "public_spa" && len(origins) != 0 {
		return httpx.Validation("allowedOrigins", "allowed origins are only for SPA clients")
	}
	if len(origins) > 10 {
		return httpx.Validation("allowedOrigins", "at most 10 allowed origins")
	}
	seen = map[string]bool{}
	for _, o := range origins {
		if !validOrigin(o) {
			return httpx.Validation("allowedOrigins", "origin must be https://host[:port] without a path")
		}
		if seen[o] {
			return httpx.Validation("allowedOrigins", "duplicate origin")
		}
		seen[o] = true
	}
	parsed, ok := scopeSet(strings.Join(scopes, " "))
	if !ok || len(parsed) != len(scopes) {
		return httpx.Validation("scopes", "scopes must include openid and only openid, profile, email")
	}
	return nil
}

func (s *Service) clientDTO(ctx context.Context, q *sqlc.Queries, c sqlc.OauthClient) (*v1.OAuthClient, error) {
	if c.Version < 1 {
		return nil, errors.New("oauthprovider: invalid client version")
	}
	r, err := q.ListOAuthClientRedirects(ctx, sqlc.ListOAuthClientRedirectsParams{WorkspaceID: c.WorkspaceID, ClientID: c.ID})
	if err != nil {
		return nil, err
	}
	out := &v1.OAuthClient{Id: c.ID.String(), WorkspaceId: c.WorkspaceID.String(), ClientId: c.ClientID, Name: c.Name, Type: wireClientType(c.ClientType), AllowedOrigins: c.AllowedOrigins, Scopes: c.Scopes, RefreshEnabled: c.RefreshEnabled, Version: uint64(c.Version), CreatedAt: timestamppb.New(c.CreatedAt)}
	if c.DisabledAt != nil {
		out.DisabledAt = timestamppb.New(*c.DisabledAt)
	}
	for _, uri := range r {
		out.RedirectUris = append(out.RedirectUris, uri.RedirectUri)
	}
	return out, nil
}

func (s *Service) management(_ http.ResponseWriter, r *http.Request, fn func(context.Context, *sqlc.Queries, uuid.UUID, identitypolicy.Principal) error) error {
	ws, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	p, err := s.resolveBearer(r)
	if err != nil {
		return apiSessionError(err)
	}
	if r.Method != http.MethodGet && !s.appOrigin(r) {
		// Not a CSRF defence (the session is a bearer, no cookie is involved): it keeps
		// management calls to the first-party app. Log what was seen so a desktop
		// pointed at an unlisted alias host is diagnosable (ADR-0102).
		slog.InfoContext(r.Context(), "oauthprovider: management origin rejected", "origin", truncate(r.Header.Get("Origin"), 200), "sec_fetch_site", truncate(r.Header.Get("Sec-Fetch-Site"), 32), "route", r.Pattern)
		return httpx.Forbidden("request origin is not an app origin")
	}
	read := r.Method == http.MethodGet
	return s.c.DB.Tx(r.Context(), func(q *sqlc.Queries) error {
		// Reads take no workspace lock and never create the policy row: the state
		// loader defaults a missing row, and lazy creation stays with admin writes.
		if !read {
			if _, err := q.LockOAuthWorkspace(r.Context(), ws); err != nil {
				return err
			}
			if _, err := q.EnsureIdentityPolicy(r.Context(), ws); err != nil {
				return err
			}
		}
		if st, d, err := s.state(r.Context(), q, p, ws, identitypolicy.ManageOAuth); err != nil {
			return apiIdentityError(st, d, err)
		}
		if err := fn(r.Context(), q, ws, p); err != nil {
			return err
		}
		// The client lock or a batch of management queries may have crossed a
		// proof deadline. A failed final check rolls back the mutation and audit.
		if st, d, err := s.state(r.Context(), q, p, ws, identitypolicy.ManageOAuth); err != nil {
			return apiIdentityError(st, d, err)
		}
		return nil
	})
}

func (s *Service) lookupClient(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, path string, lock bool) (sqlc.OauthClient, error) {
	var c sqlc.OauthClient
	var err error
	if id, parseErr := uuid.Parse(path); parseErr == nil {
		c, err = q.GetOAuthClient(ctx, sqlc.GetOAuthClientParams{WorkspaceID: ws, ID: id})
	} else {
		c, err = q.FindOAuthClient(ctx, sqlc.FindOAuthClientParams{WorkspaceID: ws, ClientID: path})
	}
	if errors.Is(err, dbNoRows()) {
		return c, &protocolError{code: "invalid_request", status: http.StatusNotFound}
	}
	if err != nil {
		return c, err
	}
	if lock {
		return q.GetOAuthClientForUpdate(ctx, sqlc.GetOAuthClientForUpdateParams{WorkspaceID: ws, ID: c.ID})
	}
	return c, nil
}

func (s *Service) listClients(w http.ResponseWriter, r *http.Request) {
	out := &v1.ListOAuthClientsResponse{}
	err := s.management(w, r, func(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, _ identitypolicy.Principal) error {
		clients, err := q.ListOAuthClients(ctx, ws)
		if err != nil {
			return err
		}
		for _, c := range clients {
			dto, err := s.clientDTO(ctx, q, c)
			if err != nil {
				return err
			}
			out.Clients = append(out.Clients, dto)
		}
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	protoResponse(w, http.StatusOK, out)
}
func (s *Service) getClient(w http.ResponseWriter, r *http.Request) {
	var out *v1.OAuthClient
	err := s.management(w, r, func(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, _ identitypolicy.Principal) error {
		c, err := s.lookupClient(ctx, q, ws, r.PathValue("client"), false)
		if err != nil {
			return err
		}
		out, err = s.clientDTO(ctx, q, c)
		return err
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	protoResponse(w, http.StatusOK, out)
}

func (s *Service) createClient(w http.ResponseWriter, r *http.Request) {
	in := &v1.CreateOAuthClientRequest{}
	if err := readProto(w, r, in); err != nil {
		writeAPIError(w, err)
		return
	}
	kind := clientType(in.Type)
	if err := validateClient(in.Name, kind, in.RedirectUris, in.AllowedOrigins, in.Scopes); err != nil {
		writeAPIError(w, err)
		return
	}
	out := &v1.OAuthClientSecretResponse{}
	err := s.management(w, r, func(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, p identitypolicy.Principal) error {
		if s.c.PlanActive != nil {
			if err := s.c.PlanActive(ctx, ws, "connecting integrations"); err != nil { // plans.RestrictedConnect
				return err
			}
		}
		clients, err := q.ListOAuthClients(ctx, ws)
		if err != nil {
			return err
		}
		active := 0
		for _, c := range clients {
			if c.DisabledAt == nil {
				active++
			}
		}
		if active >= 20 {
			return &protocolError{code: "client_limit", status: http.StatusConflict}
		}
		method := "none"
		if kind == "confidential_web" {
			method = "client_secret_basic"
		}
		scopes, _ := scopeSet(strings.Join(in.Scopes, " "))
		origins := in.AllowedOrigins
		if origins == nil {
			origins = []string{}
		}
		c, err := q.CreateOAuthClient(ctx, sqlc.CreateOAuthClientParams{WorkspaceID: ws, ClientID: opaque("calab_client_"), Name: in.Name, ClientType: kind, RefreshEnabled: in.RefreshEnabled, AllowedOrigins: origins, AuthMethod: method, Scopes: scopes, CreatedBy: &p.UserID})
		if err != nil {
			return err
		}
		for _, uri := range in.RedirectUris {
			if _, err = q.CreateOAuthClientRedirect(ctx, sqlc.CreateOAuthClientRedirectParams{WorkspaceID: ws, ClientID: c.ID, RedirectUri: uri}); err != nil {
				return err
			}
		}
		if method == "client_secret_basic" {
			out.SecretOnce = opaque("calab_os_")
			if _, err = q.CreateOAuthClientSecret(ctx, sqlc.CreateOAuthClientSecretParams{WorkspaceID: ws, ClientID: c.ID, SecretHash: hash(out.SecretOnce), ValidUntil: time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC)}); err != nil {
				return err
			}
		}
		out.Client, err = s.clientDTO(ctx, q, c)
		if err != nil {
			return err
		}
		return s.audit(ctx, q, ws, p.UserID, c.ID, "oauth_client_created")
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	protoResponse(w, http.StatusCreated, out)
}

func (s *Service) revokeClientGrants(ctx context.Context, q *sqlc.Queries, c sqlc.OauthClient, p identitypolicy.Principal, reason string) error {
	if _, err := q.RevokeWorkspaceOAuthGrants(ctx, sqlc.RevokeWorkspaceOAuthGrantsParams{WorkspaceID: c.WorkspaceID, ClientID: &c.ID, Reason: &reason}); err != nil {
		return err
	}
	// No identity invalidation: OAuth grants are re-checked on every provider use,
	// and gateway/RTC never accept provider tokens (a policy-less workspace notice
	// would only wake their sweeps).
	return s.audit(ctx, q, c.WorkspaceID, p.UserID, c.ID, reason)
}

func (s *Service) updateClient(w http.ResponseWriter, r *http.Request) {
	in := &v1.UpdateOAuthClientRequest{}
	if err := readProto(w, r, in); err != nil {
		writeAPIError(w, err)
		return
	}
	if in.Version == 0 || in.Version > 1<<63-1 {
		writeAPIError(w, oauthError("invalid_request"))
		return
	}
	expectedVersion := int64(in.Version)
	var out *v1.OAuthClient
	err := s.management(w, r, func(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, p identitypolicy.Principal) error {
		c, err := s.lookupClient(ctx, q, ws, r.PathValue("client"), true)
		if err != nil {
			return err
		}
		if c.DisabledAt != nil || c.Version != expectedVersion {
			return &protocolError{code: "config_changed", status: http.StatusConflict}
		}
		if err = validateClient(in.Name, c.ClientType, in.RedirectUris, in.AllowedOrigins, in.Scopes); err != nil {
			return err
		}
		dto, err := s.clientDTO(ctx, q, c)
		if err != nil {
			return err
		}
		scopes, _ := scopeSet(strings.Join(in.Scopes, " "))
		redirects := slices.Clone(in.RedirectUris)
		slices.Sort(redirects)
		origins := slices.Clone(in.AllowedOrigins)
		if origins == nil {
			origins = []string{}
		}
		slices.Sort(origins)
		oldOrigins := slices.Clone(c.AllowedOrigins)
		slices.Sort(oldOrigins)
		security := !slices.Equal(scopes, c.Scopes) || !slices.Equal(origins, oldOrigins) || !slices.Equal(redirects, dto.RedirectUris) || in.RefreshEnabled != c.RefreshEnabled
		if !security {
			c, err = q.UpdateOAuthClientName(ctx, sqlc.UpdateOAuthClientNameParams{WorkspaceID: ws, ID: c.ID, ExpectedVersion: c.Version, Name: in.Name})
		} else {
			c, err = q.UpdateOAuthClient(ctx, sqlc.UpdateOAuthClientParams{WorkspaceID: ws, ID: c.ID, ExpectedVersion: c.Version, Name: in.Name, Scopes: scopes, AllowedOrigins: origins, RefreshEnabled: in.RefreshEnabled})
			if err != nil {
				return err
			}
			if _, err = q.DeleteOAuthClientRedirects(ctx, sqlc.DeleteOAuthClientRedirectsParams{WorkspaceID: ws, ClientID: c.ID}); err != nil {
				return err
			}
			for _, uri := range redirects {
				if _, err = q.CreateOAuthClientRedirect(ctx, sqlc.CreateOAuthClientRedirectParams{WorkspaceID: ws, ClientID: c.ID, RedirectUri: uri}); err != nil {
					return err
				}
			}
			if err = s.revokeClientGrants(ctx, q, c, p, "oauth_client_changed"); err != nil {
				return err
			}
		}
		if err != nil {
			return err
		}
		out, err = s.clientDTO(ctx, q, c)
		if err != nil {
			return err
		}
		if !security {
			return s.audit(ctx, q, ws, p.UserID, c.ID, "oauth_client_renamed")
		}
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	protoResponse(w, http.StatusOK, out)
}

func (s *Service) deleteClient(w http.ResponseWriter, r *http.Request) {
	err := s.management(w, r, func(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, p identitypolicy.Principal) error {
		c, err := s.lookupClient(ctx, q, ws, r.PathValue("client"), true)
		if err != nil {
			return err
		}
		if c.DisabledAt != nil {
			return nil
		}
		c, err = q.DisableOAuthClient(ctx, sqlc.DisableOAuthClientParams{WorkspaceID: ws, ID: c.ID})
		if err != nil {
			return err
		}
		if _, err = q.RevokeOAuthClientSecrets(ctx, sqlc.RevokeOAuthClientSecretsParams{WorkspaceID: ws, ClientID: c.ID}); err != nil {
			return err
		}
		return s.revokeClientGrants(ctx, q, c, p, "oauth_client_disabled")
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	headers(w)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) rotateSecret(w http.ResponseWriter, r *http.Request) {
	in := &v1.RotateOAuthClientSecretRequest{}
	if err := readProto(w, r, in); err != nil {
		writeAPIError(w, err)
		return
	}
	out := &v1.OAuthClientSecretResponse{}
	err := s.management(w, r, func(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, p identitypolicy.Principal) error {
		c, err := s.lookupClient(ctx, q, ws, r.PathValue("client"), true)
		if err != nil {
			return err
		}
		if c.ClientType != "confidential_web" || c.DisabledAt != nil {
			return oauthError("invalid_request")
		}
		keys, err := q.ListOAuthClientSecrets(ctx, sqlc.ListOAuthClientSecretsParams{WorkspaceID: ws, ClientID: c.ID})
		if err != nil {
			return err
		}
		if !in.RevokeOld && len(keys) >= 2 {
			return &protocolError{code: "secret_limit", status: http.StatusConflict}
		}
		if in.RevokeOld {
			_, err = q.RevokeOAuthClientSecrets(ctx, sqlc.RevokeOAuthClientSecretsParams{WorkspaceID: ws, ClientID: c.ID})
		} else {
			dbNow, clockErr := q.IdentityDatabaseNow(ctx)
			if clockErr != nil {
				return clockErr
			}
			until := minimum(s.c.Now().Add(10*time.Minute), dbNow.Add(10*time.Minute))
			_, err = q.ExpireOAuthClientSecrets(ctx, sqlc.ExpireOAuthClientSecretsParams{WorkspaceID: ws, ClientID: c.ID, ValidUntil: until})
			if len(keys) > 0 {
				out.OldSecretValidUntil = timestamppb.New(until)
			}
		}
		if err != nil {
			return err
		}
		out.SecretOnce = opaque("calab_os_")
		if _, err = q.CreateOAuthClientSecret(ctx, sqlc.CreateOAuthClientSecretParams{WorkspaceID: ws, ClientID: c.ID, SecretHash: hash(out.SecretOnce), ValidUntil: time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC)}); err != nil {
			return err
		}
		c, err = q.UpdateOAuthClient(ctx, sqlc.UpdateOAuthClientParams{WorkspaceID: ws, ID: c.ID, ExpectedVersion: c.Version, Name: c.Name, Scopes: c.Scopes, AllowedOrigins: c.AllowedOrigins, RefreshEnabled: c.RefreshEnabled})
		if err != nil {
			return err
		}
		if err = s.revokeClientGrants(ctx, q, c, p, "oauth_secret_rotated"); err != nil {
			return err
		}
		out.Client, err = s.clientDTO(ctx, q, c)
		return err
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	protoResponse(w, http.StatusOK, out)
}
