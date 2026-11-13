package usererr

// SessionRefused: a session operation that cannot be done now. code is the
// route's stable code (not_main_session, current_session, session_running,
// not_running, not_agent_session, not_continuable, not_current,
// steer_unsupported, builtin_loop_unavailable); why is a plain reason the
// caller knows (it becomes the hint of not_continuable); details is the
// technical text.
func SessionRefused(code, why, details string) *Error {
	e := &Error{Code: code, Details: clip(details)}
	switch code {
	case "not_main_session":
		e.Message, e.Hint = "Only a main session can be resumed.", "Open an agent session to read it or to send it a message."
	case "current_session":
		e.Message, e.Hint = "This is the session you are working in.", "Make another session current first, then remove this one."
	case "session_running":
		e.Message, e.Hint = "That session is still running.", "Stop it first, or wait until it finishes."
	case "not_running":
		e.Message, e.Hint = "That session is not running.", "Nothing to stop. If you wanted to talk to it, send it a message."
	case "not_agent_session":
		e.Message, e.Hint = "That is a main session, not an agent's.", "Send messages to the main session from the conversation."
	case "not_current":
		e.Message, e.Hint = "This session is not the current one.", "Resume it to continue the conversation."
	case "steer_unsupported":
		e.Message, e.Hint = "This agent cannot take new input while it works.", "Stop it, or wait for it to finish, then send your message."
	case "builtin_loop_unavailable":
		e.Message, e.Hint, e.Action = "Octo's own agent loop is off.", "Connect a model, or pick an agent that runs on a subscription.", ActionConnectProvider
	default:
		e.Code = "not_continuable"
		e.Message, e.Hint = "That agent cannot be continued.", "Start a new task for it instead."
		if why != "" {
			e.Hint = why
		}
	}
	return e
}
