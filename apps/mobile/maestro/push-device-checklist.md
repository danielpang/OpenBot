The service extension and APNs need a signed physical-device build. Maestro's
simulator flow is only an onboarding smoke test; it does not validate APNs.

For the M0/M3 device gate, with both App IDs provisioned for the shared Keychain
and App Group:

1. Pair two hosts; allow notifications. Confirm each own-device PUT push route
   receives the APNs hex token and the build's sandbox/production environment.
2. Cache an avatar, background and lock the phone. Trigger each notice kind.
   Check title/body, Bot grouping and the cached PNG attachment.
3. Tamper with ciphertext and use another host's key. Check the generic alert
   remains and no approval action appears. Reboot without unlocking: generic
   fallback is expected until the first device unlock.
4. Open a notice from a terminated app. Check saved-host switching, the exact
   chat sequence and thread. Approve and Deny from the Lock Screen; authentication
   must run and the owner API must record the intended decision exactly once.
5. Keep that chat focused: its notification is suppressed; another host/chat
   still appears. Revoke/remove a host: its push key and cached avatars disappear.
6. Return after five minutes away; require Face ID or device passcode before
   opening owner data or executing an approval. Cancel authentication and confirm
   no decision request is sent.

Record build, device/iOS version and results. No device gate is asserted by
unit tests, native prebuild or simulator smoke tests.
