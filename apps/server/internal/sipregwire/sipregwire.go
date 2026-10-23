// Package sipregwire is the internal contract between the API and the SIP registration agent
// (cmd/sipreg, ADR-0121): JSON frames on the agent's outgoing WebSocket GET
// /api/internal/sipreg-agent (one frame per text message). Both sides are Go in this module, so
// the frames are plain structs; the package has no dependencies, so the agent does not link the
// API's packages.
//
// The frames API → agent carry the providers' passwords in clear text (the agent needs them for
// digest): only over this socket (TLS to the API in production), only in the agent's memory,
// never in Valkey, logs or on disk. Account.LogValue hides them from slog.
package sipregwire

import "log/slog"

// AgentPath is the agent's socket on the API, authenticated with
// "Authorization: Bearer <SIPREG_AGENT_TOKEN>".
const AgentPath = "/api/internal/sipreg-agent"

// Frames of the API.
const (
	OpSnapshot   = "snapshot"    // Accounts = every account to register (replaces what the agent holds)
	OpAccountSet = "account_set" // Account added or changed
	OpAccountDel = "account_del" // WS: unregister and forget
)

// Frames of the agent.
const (
	OpHello        = "hello"         // after connecting: the API answers with a snapshot
	OpRegistration = "registration"  // a registration's state (on change and every 10 min)
	OpInvite       = "invite"        // an INVITE over the registration was handed to LiveKit SIP
	OpInviteResult = "invite_result" // how its INVITE transaction ended (Code)
	OpBye          = "bye"           // the call's dialog ended (By: provider | livekit)
)

// Registration states (sip_accounts.reg_status).
const (
	StatusRegistering = "registering"
	StatusRegistered  = "registered"
	StatusFailed      = "failed"
	StatusOff         = "off"
)

// Account is one SIP account the agent registers at its provider.
type Account struct {
	WS          string `json:"ws_id"`
	ContactUser string `json:"contact_user"` // the opaque user part of our Contact (and the loopback trunk's auth user)
	Registrar   string `json:"registrar"`    // host:port the REGISTERs go to
	Domain      string `json:"domain"`       // the AOR domain
	Transport   string `json:"transport"`    // udp | tcp
	Username    string `json:"username"`
	AuthUser    string `json:"auth_username"`
	Password    string `json:"password"`
	Expires     int    `json:"expires"`       // requested, seconds
	Keepalive   int    `json:"keepalive_sec"` // 0 = off
	// AllowedSources: IP addresses / CIDR ranges INVITEs over this registration may come from
	// (the provider host's and the registrar's addresses, the workspace's ranges, the server's
	// SIP_INBOUND_ALLOWED_ADDRESSES); the agent adds the registrar addresses it resolves itself.
	AllowedSources []string `json:"allowed_sources"`
	Number         string   `json:"number"` // the workspace's caller ID (E.164): the called number on leg B
	TrunkUser      string   `json:"trunk_user"`
	TrunkPassword  string   `json:"trunk_password"` // digest of the loopback LiveKit trunk
}

// LogValue keeps the passwords and the contact token out of logs.
func (a Account) LogValue() slog.Value {
	return slog.GroupValue(slog.String("ws", a.WS), slog.String("user", a.Username), slog.String("registrar", a.Registrar),
		slog.String("transport", a.Transport))
}

// Command is a frame API → agent.
type Command struct {
	Op       string    `json:"op"`
	Accounts []Account `json:"accounts,omitempty"`
	Account  *Account  `json:"account,omitempty"`
	WS       string    `json:"ws_id,omitempty"`
}

// Event is a frame agent → API.
type Event struct {
	Op             string `json:"op"`
	WS             string `json:"ws_id,omitempty"`
	Status         string `json:"status,omitempty"`
	Error          string `json:"error,omitempty"`
	ExpiresAt      int64  `json:"expires_at,omitempty"` // unix seconds
	Contact        string `json:"contact,omitempty"`    // the registered Contact URI
	ProviderCallID string `json:"provider_call_id,omitempty"`
	LegBCallID     string `json:"leg_b_call_id,omitempty"`
	From           string `json:"from,omitempty"` // the caller's number / user part
	To             string `json:"to,omitempty"`
	Source         string `json:"source,omitempty"` // the INVITE's source IP
	Code           int    `json:"code,omitempty"`
	By             string `json:"by,omitempty"`
}

// MaxFrame bounds one frame on either side (a snapshot of every account).
const MaxFrame = 1 << 20
