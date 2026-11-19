package usererr

// Remote access (docs/superpowers/specs/2026-11-14-remote-access-mobile-design.md): what the computer and a paired
// phone are told. Codes are stable; the web client keys its "pair again" screen on the device_* ones.

// CloudflaredMissing: remote access needs the cloudflared program and it is not on PATH (or the configured path).
// install is the install line for this OS.
func CloudflaredMissing(install string) *Error {
	return &Error{
		Code: "cloudflared_missing", Message: "Remote access needs Cloudflare's tunnel program, and it is not installed.",
		Hint: "Install it, then check again.", Command: install, Action: ActionRetry,
	}
}

// TunnelFailed: cloudflared kept failing; details is the tail of its output.
func TunnelFailed(details string) *Error {
	return &Error{
		Code: "tunnel_failed", Message: "The tunnel to Cloudflare could not be opened.",
		Hint: "Check the internet connection, then turn remote access on again.", Action: ActionRetry, Details: clip(details),
	}
}

// Remote is every other remote-access refusal, by its code. An unknown code is a plain refusal.
func Remote(code string) *Error {
	e := &Error{Code: code}
	switch code {
	case "remote_ack_required":
		e.Message, e.Hint = "Remote access has to be confirmed the first time.", "Read the warning, then confirm it."
	case "remote_off":
		e.Message, e.Hint = "Remote access is off.", "Turn it on first."
	case "remote_forbidden":
		e.Message, e.Hint = "A paired phone cannot do this.", "Do it on the computer."
	case "remote_decision_forbidden":
		e.Message, e.Hint = "A paired phone can only allow or deny one request at a time.", "Save a rule or allow more on the computer."
	case "remote_read_only":
		e.Message, e.Hint = "This phone can only read.", "Allow more for it in Remote access on the computer."
	case "device_not_paired":
		e.Message, e.Hint = "This phone is not paired, or it was disconnected on the computer.", "Pair it again with a new code from the computer."
	case "device_pending":
		e.Message, e.Hint = "This phone is waiting to be allowed on the computer.", "Allow it in Remote access on the computer."
	case "device_expired":
		e.Message, e.Hint = "This phone was not used for too long and was disconnected.", "Pair it again with a new code from the computer."
	case "pairing_code_invalid":
		e.Message, e.Hint = "That pairing code is not right.", "Check the code on the computer and type it again."
	case "pairing_code_expired":
		e.Message, e.Hint = "That pairing code has expired.", "Ask the computer for a new code."
	case "pairing_locked":
		e.Message, e.Hint = "Too many wrong codes were tried.", "Ask the computer for a new code."
	case "pairing_rate_limited":
		e.Message, e.Hint = "Too many tries at once.", "Wait a second, then try again."
	case "stream_gone":
		e.Message, e.Hint = "The live updates stopped.", "Reload to catch up."
	case "query_token_refused":
		e.Message, e.Hint = "A token in the address is not accepted here.", "Send it in the request header instead."
	default:
		e.Message, e.Hint = "Remote access refused this.", "Do it on the computer."
	}
	return e
}

// RemoteCodes lists the codes Remote knows (for the catalogue tests and the docs).
func RemoteCodes() []string {
	return []string{
		"remote_ack_required", "remote_off", "remote_forbidden", "remote_decision_forbidden", "remote_read_only", "device_not_paired", "device_pending",
		"device_expired", "pairing_code_invalid", "pairing_code_expired", "pairing_locked", "pairing_rate_limited",
		"stream_gone", "query_token_refused",
	}
}
