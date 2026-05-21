package auth
import "crypto/hmac"
const ServiceTokenHeader = "X-Service-Token"
func verify(a, b []byte) bool { return hmac.Equal(a, b) }
type Session struct { UserID string }
func serviceSession(service string) Session { return Session{UserID: "service:" + service} }
