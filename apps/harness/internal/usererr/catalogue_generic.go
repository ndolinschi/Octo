package usererr

import (
	"fmt"
	"strings"
)

// generic is the plain wording of a route's own error code, for the failures a
// route reports in its own words (a malformed body, a missing item, a limit).
// The route's technical sentence is kept as Details.
var generic = map[string]struct {
	message, hint string
	action        Action
}{
	"invalid_request":            {"That request was not valid.", "Check what you entered, then try again.", ActionNone},
	"not_found":                  {"That item no longer exists.", "Refresh the list, then try again.", ActionRetry},
	"unauthorized":               {"Octo's local server did not accept this app.", "Restart Octo, then try again.", ActionNone},
	"forbidden":                  {"That cannot be changed from here.", "Change it where it was set.", ActionNone},
	"busy":                       {"A folder chooser is already open.", "Close it, then try again.", ActionNone},
	"file_too_large":             {"That file is too large.", "Use a smaller file.", ActionNone},
	"attachment_too_large":       {"That image is too large.", "Make it smaller, then add it again.", ActionNone},
	"message_too_large":          {"That message is too large.", "Send less at a time.", ActionNone},
	"too_many_sessions":          {"There are too many editor sessions open for this project.", "Close one, then try again.", ActionNone},
	"session_closed":             {"That editor session has ended.", "Reopen the file.", ActionRetry},
	"already_subscribed":         {"That editor session is already open elsewhere.", "Close the other one, then try again.", ActionNone},
	"shutting_down":              {"Octo is shutting down.", "Start it again, then retry.", ActionNone},
	"no_review_workspace":        {"No review is open in the workspace.", "Open a review in the workspace first.", ActionNone},
	"not_ready":                  {"That agent is not ready yet.", "Check it again, then try once more.", ActionRecheckProvider},
	"discovery_off":              {"Looking for models is switched off.", "Type a model name yourself, or switch it on in Settings.", ActionOpenSettings},
	"internal":                   {"Something went wrong inside Octo.", "Try again. If it keeps happening, copy the details when you report it.", ActionRetry},
	"octo_command":               {"That is an Octo command, not a message.", "Use the command's own button or menu.", ActionNone},
	"completion_off":             {"Suggestions are switched off.", "Switch them on in Settings if you want them.", ActionOpenSettings},
	"attachment_not_found":       {"That image is gone.", "Add it again.", ActionNone},
	"unsupported_media_type":     {"That file type is not supported.", "Use a PNG, JPEG, WebP or GIF image.", ActionNone},
	"binary_file":                {"That file is not text.", "Octo can only open text files here.", ActionNone},
	"revert_unavailable":         {"That change cannot be undone.", "Octo no longer has the earlier content.", ActionNone},
	"review_workspace_read_only": {"The review workspace is read-only.", "Close the review to edit these files.", ActionNone},
	"rewind_conflict":            {"Some files changed since the agent edited them.", "Check the files listed, then rewind again.", ActionNone},
	"review_closed":              {"This review is closed.", "Reopen it to go on.", ActionNone},
	"comment_submitted":          {"That comment was already sent.", "A sent comment can no longer be changed.", ActionNone},
	"comments_changed":           {"The pending comments changed since you looked.", "Look at them again, then submit.", ActionNone},
	"detached_head":              {"The working copy is not on a branch.", "Confirm to switch anyway; its newest commits stay in Git's history.", ActionNone},
	"branch_diverged":            {"The local branch has commits the pull request does not.", "It was left as it is. Rename or reset that branch yourself.", ActionNone},
	"invalid_review":             {"This review has no repository.", "Open the review again from the pull request.", ActionNone},
	"no_folder":                  {"This project has no folder yet.", "Add the repository folder to the project first.", ActionOpenSettings},
	"no_host":                    {"No code host is set up.", "Review a local branch instead.", ActionNone},
	"not_a_git_repo":             {"That folder is not a Git repository.", "Pick a folder that is one.", ActionNone},
	"pr_not_open":                {"That pull request is not open.", "Pick an open one.", ActionNone},
	"start_failed":               {"That command could not start.", "Check the command in the project's settings.", ActionOpenSettings},
	"thread_missing":             {"The thread you reply to is gone from the pull request.", "Refresh the threads, then review the reply.", ActionRetry},
	"too_many_runs":              {"Too many commands are running at once.", "Wait for one to finish, or stop one.", ActionNone},
	"worktree_missing":           {"The review's copy of the code is gone.", "Open the review again to make it.", ActionRetry},
	"empty_comment":              {"A comment cannot be empty.", "Write something, then save.", ActionNone},
	"empty_review":               {"The review has nothing to submit.", "Add a comment or a verdict first.", ActionNone},
	"invalid_verdict":            {"That verdict is not one of the choices.", "Pick approve, comment or request changes.", ActionNone},
	"line_not_in_diff":           {"That line is not in the pull request's changes.", "Comment on a line the diff shows.", ActionNone},
	"path_not_in_diff":           {"That file is not in the pull request's changes.", "Comment on a file the diff shows.", ActionNone},
	"not_a_pull_request":         {"That is not a pull request.", "Paste a pull request link or number.", ActionNone},
	"unknown_thread":             {"That thread does not exist.", "Refresh the threads.", ActionRetry},
	"unknown_ref":                {"Git does not know that branch or commit.", "Pick one from the list.", ActionNone},
	"unknown_folder":             {"That folder is not part of the project.", "Pick one of the project's folders.", ActionNone},
	"unknown_setting":            {"Octo has no such setting.", "Pick one from the list in Settings.", ActionOpenSettings},
	"setting_locked":             {"That setting is fixed by how Octo was started.", "Change it where Octo is started.", ActionNone},
	"invalid_value":              {"That value is not valid for this setting.", "Check it, then save again.", ActionNone},
	"command_not_found":          {"That command does not exist.", "Pick one from the list.", ActionNone},
	"review_not_found":           {"That review no longer exists.", "Open the list again.", ActionRetry},
	"not_main_session":           {"Only a main session can be resumed.", "Open an agent session to read it or to send it a message.", ActionNone},
	"current_session":            {"This is the session you are working in.", "Make another session current first, then remove this one.", ActionNone},
	"session_running":            {"That session is still running.", "Stop it first, or wait until it finishes.", ActionNone},
	"not_running":                {"That session is not running.", "Nothing to stop. If you wanted to talk to it, send it a message.", ActionNone},
	"not_agent_session":          {"That is a main session, not an agent's.", "Send messages to the main session from the conversation.", ActionNone},
	"not_current":                {"This session is not the current one.", "Resume it to continue the conversation.", ActionNone},
	"not_continuable":            {"That agent cannot be continued.", "Start a new task for it instead.", ActionNone},
	"builtin_loop_unavailable":   {"Octo's own agent loop is off.", "Connect a model, or pick an agent that runs on a subscription.", ActionConnectProvider},
	"no_rule":                    {"That rule cannot be saved.", "Check it and try again.", ActionNone},
}

// GenericCodes lists the codes Generic knows (for tests and docs).
func GenericCodes() []string {
	out := make([]string, 0, len(generic))
	for k := range generic {
		out = append(out, k)
	}
	return out
}

// Generic is the catalogue's plain reading of a route error code whose own
// sentence is technical; technical becomes Details. An unknown code gets the
// catch-all wording, keeping its code.
func Generic(code, technical string) *Error {
	if e := specific(code, technical); e != nil {
		return e
	}
	g, ok := generic[code]
	if !ok {
		return &Error{Code: code, Message: "Octo could not do that.", Hint: "Try again.", Action: ActionRetry, Details: clip(technical)}
	}
	return &Error{Code: code, Message: g.message, Hint: g.hint, Action: g.action, Details: clip(technical)}
}

// NameRequired: a project or note needs a name.
func NameRequired() *Error {
	return &Error{Code: "invalid_request", Message: "A name is required.", Hint: "Type a name, then save again."}
}

// CodeRequestTooLarge: a request body over the bridge's limit (413).
const CodeRequestTooLarge = "request_too_large"

// RequestTooLarge: a request body over the bridge's limit of limit bytes (a
// long paste in a message), with the limit in the sentence.
func RequestTooLarge(limit int64) *Error {
	return &Error{
		Code: CodeRequestTooLarge, Message: fmt.Sprintf("That is too much to send at once (the limit is %s).", sizeText(limit)),
		Hint:    "Send less at a time, or save the long text as a file in the project folder and mention the file.",
		Details: fmt.Sprintf("request body over %d bytes", limit),
	}
}

// CodeDataDirInUse: a second Octo service started on a data folder in use.
const CodeDataDirInUse = "data_dir_in_use"

// DataDirInUse: another Octo service holds the data folder dir (its lock file);
// this one stops before it opens or changes anything there.
func DataDirInUse(dir, details string) *Error {
	return &Error{
		Code: CodeDataDirInUse, Message: "Another Octo service is already using this data folder.",
		Hint:    "Quit the other Octo (or the harness started in a terminal), then start this one again, or give this one another data folder.",
		Details: clip(strings.TrimSpace(dir + " " + details)),
	}
}

// sizeText is n bytes as "1 MB" (whole MiB) or "512 KB".
func sizeText(n int64) string {
	if n >= 1<<20 && n%(1<<20) == 0 {
		return fmt.Sprintf("%d MB", n>>20)
	}
	return fmt.Sprintf("%d KB", (n+1023)>>10)
}

// FolderInvalid: a folder the person picked cannot be used.
func FolderInvalid(path, why string) *Error {
	return &Error{
		Code: "invalid_request", Message: "That folder cannot be used for the project.",
		Hint: "Pick an existing folder on this computer.", Details: clip(fmt.Sprintf("%s: %s", path, why)),
	}
}

// NoteTitleTaken: another note has the title already.
func NoteTitleTaken(title, id string) *Error {
	return &Error{
		Code: "invalid_request", Message: "A note with that title exists already.",
		Hint: "Open it to change it, or choose another title.", Details: clip(fmt.Sprintf("title %q is note %s", title, id)),
	}
}
