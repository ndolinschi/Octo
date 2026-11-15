package usererr

// FormAnswerRefused: a form's answer was refused; refused counts the fields
// with a message (the body's error.fields), technical names them ("email:
// Enter an email address…"), never their values. The code stays
// invalid_request (spec 2026-11-15, decision 4).
func FormAnswerRefused(refused int, technical string) *Error {
	msg := "Some answers in the form need attention."
	if refused == 1 {
		msg = "One answer in the form needs attention."
	}
	return &Error{Code: "invalid_request", Message: msg, Hint: "Fix the marked fields, then submit again.", Details: clip(technical)}
}
