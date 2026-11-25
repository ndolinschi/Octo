package fakeacp

// advertiseCommands sends available_commands_update. At session start (fresh)
// the list comes from EnvCommands and nothing is sent when the knob is unset;
// mid-session it sends the current list as it is.
func (a *agent) advertiseCommands(fresh bool) {
	a.mu.Lock()
	if fresh {
		a.commands = a.opts.commands
	}
	cmds := a.commands
	a.mu.Unlock()
	if fresh && len(cmds) == 0 {
		return
	}
	if cmds == nil {
		cmds = []map[string]any{}
	}
	a.update(map[string]any{"sessionUpdate": "available_commands_update", "availableCommands": cmds})
}
