package bridge

// SetPickerGOOS makes the folder chooser behave as on goos and returns the undo.
func SetPickerGOOS(goos string) func() {
	old := pickerGOOS
	pickerGOOS = goos
	return func() { pickerGOOS = old }
}
