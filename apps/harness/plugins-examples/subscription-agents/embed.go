// Package subscriptionagents embeds the subscription-agents plugin manifest so
// the harness binary carries it as a built-in plugin. plugin.json stays the
// single source: it is embedded from here, not copied.
package subscriptionagents

import _ "embed"

// Name is the plugin name inside Manifest.
const Name = "subscription-agents"

// Manifest is the raw plugin.json.
//
//go:embed plugin.json
var Manifest []byte
