---
slug: domain/push-notifications
title: Push Notifications
loadWhen:
  - kind: hint.framework
    value: push
  - kind: hint.framework
    value: notifications
  - kind: hint.framework
    value: push-notifications
sizeTarget: 500
priority: 7
---

# Push Notifications

## When this applies
Use this for APNs, FCM, notification permission flows, token registration, foreground handling, and notification deep links.

## Core rules
- iOS uses `UserNotifications`; request alert, badge, and sound permission after onboarding.
- Register with APNs through `UIApplication.shared.registerForRemoteNotifications()`.
- Upload APNs tokens from `didRegisterForRemoteNotificationsWithDeviceToken`.
- Use `UNNotificationCategory` and `UNNotificationAction` for actionable notifications.
- Notification tap handlers read a `deeplink` payload and route through the app router.
- Android uses Firebase Messaging and a `FirebaseMessagingService`.
- Override `onNewToken` and `onMessageReceived`; post token rotations to the backend.
- Declare NotificationChannels in `Application.onCreate()` before posting notifications.
- Request `POST_NOTIFICATIONS` at runtime on Android 13+.
- Backend sends APNs HTTP/2 with auth keys and FCM HTTP v1.

## Common pitfalls
- Locked iOS token access: background refresh needs `AfterFirstUnlock` Keychain tier.
- No Android channel: notifications silently drop on Android 8+.
- No API 33 permission: UI notifications do not show.

## House style
Generated prompt hardening requires entitlement evidence, permission request evidence, token upload, tap routing, and a real-device pending note when simulator proof is insufficient.

## Verification commands
- `rg -n "UNUserNotificationCenter|registerForRemoteNotifications|didRegisterForRemoteNotifications" .`
- `rg -n "FirebaseMessagingService|onNewToken|POST_NOTIFICATIONS|NotificationChannel" .`
- `rg -n "deeplink|didReceive|onMessageReceived" .`

## Canonical sources
- ~/workspaces/reference-appgen/api/pkg/reference-appgen/migrations/00016_harden_push_notifications_ios_prompts.sql
- ~/workspaces/reference-apps/finance-sample/app/Services/KeychainService.swift
