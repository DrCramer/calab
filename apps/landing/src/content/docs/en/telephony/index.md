---
title: Setting up telephony
description: How to connect a SIP provider, receive incoming calls, assign internal numbers, build groups and a voice menu, and turn on call recording and transfer.
order: 1
---

Telephony turns your provider's SIP number into a small team phone system: your people answer incoming calls in the Calab app (desktop, web app, including a phone's browser), and outgoing calls are dialed from a voice room. This chapter is for workspace admins. Telephony is part of the **Business** and **Enterprise** plans; on other plans a saved setup stays readable but cannot be turned on. The calls themselves are paid to your SIP provider.

Everything is configured in "Workspace settings → Telephony" (Настройки пространства → Телефония). Tabs: **Active calls**, **Numbers**, **Groups**, **IVR**, **Settings**. The tab names in the app follow the interface language.

## 1. Connect the provider

1. Open the **Settings** tab and fill in what your provider's portal gives you: server, transport (UDP, TCP or TLS), login, password and Caller ID. The password is stored encrypted and is never shown again; an empty field keeps the stored one.
2. Press **Check connection**: Calab makes a short real call to the Caller ID and shows the result.
3. Turn telephony on and save.

To dial numbers from a voice room a member needs the "Place calls" permission (nobody has it by default); destinations can be limited by prefixes. Guests cannot call. The call journal is on the "Active calls" tab, under the list.

## 2. Turn on incoming calls

In the **Incoming** card of the Settings tab choose how the provider delivers calls:

- **By registration** — the recommended way. The Calab server registers with the provider using the login and password, like a desk phone, and receives calls over that registration. You do not open or forward any ports. The card shows the state: "Registered until …" or the reason for a failure (for example, the provider did not accept the login or password). The registrar, SIP domain and interval can be changed in the collapsed block; you rarely need it.
- **To the server's address** — the provider calls the server's public address (an IP trunk, no registration). If it calls from an address other than its host's, list its addresses or ranges.

Then choose **where to route** incoming calls: a person or a bot, a group or a voice menu. If the server does not accept incoming calls yet (the auto-answer worker is not configured), the tabs say so; you can prepare numbers, groups and menus in advance. The caller pays the provider from the moment the menu answers or people's phones ring.

## 3. Assign internal numbers

On the **Numbers** tab add a number of 2–6 digits and assign it to a person or a bot. The description, such as "Accounting", is only a label. Every member except guests sees the numbers; a member's card shows theirs as "Internal number".

The **"Do not accept external calls by extension"** switch keeps the number from being dialed from the voice menu: the caller hears the menu again. Menu keys, groups and fallbacks that you set up yourself still ring that person.

## 4. Build groups

On the **Groups** tab create a group — it has its own number and members (up to 20 numbers of people or bots):

- **All at once** — everyone rings together, the first to answer takes the call; people who become free join in.
- **One by one** — one at a time in the set order, starting after whoever answered last time; set how many seconds each one rings. People who are offline or busy are skipped.

**Fallback if nobody answers** is off by default: the group then rings until someone answers or the caller hangs up. Turn it on and set "After N s transfer to …": another group, a person or a bot, a voice menu, or hang up (5 to 600 s). A single call goes through at most three group-to-group fallbacks.

## 5. Set up the voice menu (IVR)

On the **IVR** tab create a menu:

1. Upload the **greeting recording**: MP3, WAV or OGG, up to 10 MB and 3 minutes. The volume is levelled automatically. Without a recording the menu stays silent and the call goes straight to the "If nothing is pressed" rule.
2. Assign the **keys** (0–9, `*`, `#`): each to a person or a bot, a group, another menu, a repeat, or hang up.
3. Set how long to **wait for a key** (3–15 s), how many **repeats** (1–5) and what to do **if nothing is pressed**.

A key can be pressed without waiting for the recording to end. With **"Allow dialing an extension"** on, the caller can dial the internal number of a person, a bot or a group: dialing ends with a 3-second pause or `#`; an unknown number or one closed to external callers makes the menu play again.

To send incoming calls into a menu, pick it as the destination in the Incoming card.

## 6. Turn on call recording

In the **Call recording** card (Settings tab) turn on recording of incoming and/or outgoing calls. An incoming call is recorded from the moment a person or a bot answers, not while the menu plays; an outgoing recording includes everyone who speaks in the room the call is made from. Files (Ogg/Opus) land on the workspace **Disk** in the `phone_recordings` folder, one subfolder per day, and use the workspace's storage. At first only the owner sees the folder and shares access as needed.

Warning callers about recording is the admin's job: in the voice menu settings upload a **"Recording notice"** file (same format). It plays to the caller before they are connected to a person, a bot or a group.

## 7. Transfer calls and watch them

During a call a member presses **Transfer** and picks a colleague, an internal number or dials a number. The transfer waits: you stay with the caller until the target answers. If it answers, the call is theirs; if it does not within 30 seconds, declines, or you press "Cancel transfer", the call stays with you.

The **Active calls** tab lists calls in progress: direction, step (voice menu, ringing a group, talking) and who is on the line. The list refreshes itself while the tab is open. Without the permission to view journals the caller's number is masked.

## Bots and telephony

A bot can be given an internal number and used as the target of a menu key, a fallback or a group member. A bot does **not** answer such calls by itself: its code has to handle the `SIP_INBOUND_RING` event, confirm the call with an accept request and join the call's voice room — everything after that (speech recognition and synthesis, creating tasks) is the bot's own logic. There is no ready-made no-code bot, so first make sure your bot does this; otherwise a call to the bot goes unanswered and falls through to the fallback or ends. More on bots in [Bots and integration API](../bots).
