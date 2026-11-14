package remoteaccess

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Settings (environment, or harness.env). None of them can be changed through the API.
const (
	EnvAddr       = "HARNESS_REMOTE_ADDR"
	EnvWebDir     = "HARNESS_REMOTE_WEB_DIR"
	EnvWebProxy   = "HARNESS_REMOTE_WEB_PROXY"
	EnvAllow      = "HARNESS_REMOTE_ALLOW"
	EnvDeviceIdle = "HARNESS_REMOTE_DEVICE_IDLE_DAYS"
	EnvIdleOff    = "HARNESS_REMOTE_IDLE_OFF_HOURS"
)

// OptionsFromEnv reads the remote-access settings into o (everything but the wiring).
func OptionsFromEnv(o *Options, getenv func(string) string) error {
	if getenv == nil {
		getenv = os.Getenv
	}
	o.Cloudflared = getenv(EnvCloudflared)
	o.Addr = strings.TrimSpace(getenv(EnvAddr))
	o.WebDir = strings.TrimSpace(getenv(EnvWebDir))
	o.WebProxy = strings.TrimSpace(getenv(EnvWebProxy))
	perms, err := ParsePerms(getenv(EnvAllow))
	if err != nil {
		return err
	}
	o.Allow = perms
	if v := strings.TrimSpace(getenv(EnvDeviceIdle)); v != "" {
		n, err := strconv.ParseFloat(v, 64)
		if err != nil || n <= 0 {
			return fmt.Errorf("%s must be a number of days above 0", EnvDeviceIdle)
		}
		o.DeviceIdle = time.Duration(n * float64(24*time.Hour))
	}
	if v := strings.TrimSpace(getenv(EnvIdleOff)); v != "" {
		n, err := strconv.ParseFloat(v, 64)
		if err != nil || n < 0 {
			return fmt.Errorf("%s must be a number of hours (0 = never)", EnvIdleOff)
		}
		o.IdleOff = time.Duration(n * float64(time.Hour))
		if n == 0 {
			o.IdleOff = -1
		}
	}
	return nil
}
