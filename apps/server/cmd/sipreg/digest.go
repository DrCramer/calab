package main

import (
	"errors"
	"strings"

	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"
)

// challengeHeaders: the challenge header of a 401 / 407 and the header the answer goes into.
func challengeHeaders(code int) (challenge, answer string) {
	if code == sip.StatusProxyAuthRequired {
		return "Proxy-Authenticate", "Proxy-Authorization"
	}
	return "WWW-Authenticate", "Authorization"
}

var errNoChallenge = errors.New("digest: no usable challenge")

// pickChallenge takes the strongest digest challenge we can answer (SHA-256 over MD5, RFC
// 8760), with qop "auth" or none (auth-int is not offered by SIP providers in practice).
func pickChallenge(res *sip.Response) (*digest.Challenge, error) {
	name, _ := challengeHeaders(res.StatusCode)
	var best *digest.Challenge
	for _, h := range res.GetHeaders(name) {
		c, err := digest.ParseChallenge(h.Value())
		if err != nil {
			continue
		}
		c.Algorithm = strings.ToUpper(c.Algorithm)
		if c.Algorithm != "" && c.Algorithm != "MD5" && c.Algorithm != "SHA-256" {
			continue
		}
		if len(c.QOP) > 0 && !c.SupportsQOP("auth") {
			continue
		}
		if best == nil || c.Algorithm == "SHA-256" {
			best = c
		}
	}
	if best == nil {
		return nil, errNoChallenge
	}
	return best, nil
}

// authorize answers the challenge of res on req (replacing an earlier answer). The password is
// only hashed here; it is never put into a header or a log.
func authorize(req *sip.Request, res *sip.Response, user, password string) (*digest.Challenge, error) {
	chal, err := pickChallenge(res)
	if err != nil {
		return nil, err
	}
	cred, err := digest.Digest(chal, digest.Options{Method: string(req.Method), URI: req.Recipient.String(), Username: user, Password: password, Count: 1})
	if err != nil {
		return nil, err
	}
	_, answer := challengeHeaders(res.StatusCode)
	req.RemoveHeader("Authorization")
	req.RemoveHeader("Proxy-Authorization")
	req.AppendHeader(sip.NewHeader(answer, cred.String()))
	return chal, nil
}
