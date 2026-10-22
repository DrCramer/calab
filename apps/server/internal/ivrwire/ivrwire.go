// Package ivrwire is the internal contract between the API and the IVR worker (cmd/ivr,
// ADR-0117 §2): JSON frames on the worker's outgoing WebSocket GET /api/internal/ivr-agent
// (one frame per text message) and the paths it uses. Both sides are Go in this module, so the
// frames are plain structs (no proto contract for clients); the package has no dependencies,
// so the worker does not link the API's packages.
package ivrwire

// Paths on the API, authenticated with "Authorization: Bearer <IVR_AGENT_TOKEN>".
const (
	AgentPath = "/api/internal/ivr-agent"
	// FilesPath + "<file id>": a prompt file (Ogg/Opus) of a voice menu; immutable per id.
	FilesPath = "/api/internal/ivr-agent/files/"
)

// Commands of the API.
const (
	OpJoin  = "join"  // connect to Room with Token
	OpPlay  = "play"  // play Play, replacing what plays
	OpStop  = "stop"  // play silence
	OpLeave = "leave" // disconnect
)

// Events of the worker.
const (
	OpHello  = "hello"  // after connecting: Calls = the calls it is still in
	OpJoined = "joined" // in the call's room, the audio track published
	OpPlayed = "played" // a non-looping Play ended (not when replaced or stopped)
	OpDTMF   = "dtmf"   // the caller pressed Digit (SipDTMF data packet of LiveKit SIP)
	OpLeft   = "left"   // out of the call's room (Leave, the room closed, or a lost connection)
	OpError  = "error"  // a command failed: Error says why
)

// Play is what to play: a prompt file or a built-in sound, once or in a loop.
type Play struct {
	FileID  string `json:"file_id,omitempty"`
	Builtin string `json:"builtin,omitempty"`
	Loop    bool   `json:"loop,omitempty"`
}

// BuiltinRingback is the worker's ringing tone (the caller hears it while people's devices ring).
const BuiltinRingback = "ringback"

// Command is a frame API → worker.
type Command struct {
	Op    string `json:"op"`
	Call  string `json:"call"`
	Room  string `json:"room,omitempty"`
	Token string `json:"token,omitempty"`
	Play  *Play  `json:"play,omitempty"`
}

// Event is a frame worker → API.
type Event struct {
	Op    string   `json:"op"`
	Call  string   `json:"call,omitempty"`
	Digit string   `json:"digit,omitempty"`
	Error string   `json:"error,omitempty"`
	Calls []string `json:"calls,omitempty"`
}

// MaxFrame bounds one frame on either side (commands carry a LiveKit token).
const MaxFrame = 16 << 10
