package rtc

import (
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
)

// Grant maps room permissions to LiveKit participant permissions (docs/04):
//
//	canSubscribe      = VIEW_ROOM & CONNECT
//	canPublishSources = SPEAK → microphone; STREAM (and a free stream slot) → screen_share(+audio);
//	                    VIDEO (and a camera held: /camera/request or a webcam on) → camera
//
// roomAdmin is never given to clients: moderation goes through the API.
func Grant(bits perm.Bits, streamSlot, camera bool) Permission {
	join := bits.Has(perm.ViewRoom | perm.Connect)
	src := []TrackSource{}
	if join && bits.Has(perm.Speak) {
		src = append(src, SourceMicrophone)
	}
	if join && streamSlot && bits.Has(perm.Stream) {
		src = append(src, SourceScreenShare, SourceScreenShareAudio)
	}
	if join && camera && bits.Has(perm.Video) {
		src = append(src, SourceCamera)
	}
	return Permission{
		CanSubscribe:      join,
		CanPublish:        len(src) > 0,
		CanPublishData:    join, // ephemeral in-call signals (reactions, raise hand)
		CanPublishSources: src,
	}
}

// ClampPreset returns the wanted preset limited by the room maximum; UNSPECIFIED wanted
// means the maximum.
func ClampPreset(wanted, maxPreset v1.ScreenSharePreset) v1.ScreenSharePreset {
	if maxPreset == v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED {
		maxPreset = v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080
	}
	if wanted == v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED || !plans.IsStreamPreset(wanted) || plans.ComparePresets(wanted, maxPreset) > 0 {
		return maxPreset
	}
	return wanted
}
