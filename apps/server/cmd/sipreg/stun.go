package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"net"
	"time"
)

// stunPublicIP asks a STUN server (RFC 5389 Binding) for this host's public IPv4 — the address
// Contact and Via carry when SIP_REGISTRAR_PUBLIC_IP is not set (like use_external_ip of
// LiveKit SIP).
func stunPublicIP(ctx context.Context, server string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "udp4", server)
	if err != nil {
		return "", err
	}
	defer func() { _ = conn.Close() }()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	req := make([]byte, 20)
	binary.BigEndian.PutUint16(req[0:], 0x0001) // Binding Request
	binary.BigEndian.PutUint32(req[4:], stunCookie)
	if _, err := rand.Read(req[8:20]); err != nil {
		return "", err
	}
	if _, err := conn.Write(req); err != nil {
		return "", err
	}
	buf := make([]byte, 1500)
	n, err := conn.Read(buf)
	if err != nil {
		return "", err
	}
	return parseStunResponse(buf[:n], req[8:20])
}

const stunCookie = 0x2112A442

var errStun = errors.New("stun: no mapped address in the response")

// parseStunResponse takes XOR-MAPPED-ADDRESS (or MAPPED-ADDRESS) of a Binding Success Response.
func parseStunResponse(b, txID []byte) (string, error) {
	if len(b) < 20 || binary.BigEndian.Uint16(b[0:]) != 0x0101 || binary.BigEndian.Uint32(b[4:]) != stunCookie || string(b[8:20]) != string(txID) {
		return "", errStun
	}
	end := 20 + int(binary.BigEndian.Uint16(b[2:]))
	if end > len(b) {
		return "", errStun
	}
	var mapped string
	for i := 20; i+4 <= end; {
		typ, l := binary.BigEndian.Uint16(b[i:]), int(binary.BigEndian.Uint16(b[i+2:]))
		v := i + 4
		if v+l > end {
			break
		}
		if l >= 8 && b[v+1] == 0x01 { // IPv4
			ip := make(net.IP, 4)
			copy(ip, b[v+4:v+8])
			switch typ {
			case 0x0020: // XOR-MAPPED-ADDRESS
				for k := range ip {
					ip[k] ^= byte(uint32(stunCookie) >> (24 - 8*k)) //nolint:gosec // one byte of the cookie
				}
				return ip.String(), nil
			case 0x0001: // MAPPED-ADDRESS
				mapped = ip.String()
			}
		}
		i = v + (l+3)&^3
	}
	if mapped != "" {
		return mapped, nil
	}
	return "", errStun
}
