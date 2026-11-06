# OpenBots Terms and Conditions

Last updated: November 5, 2026

These Terms and Conditions ("Terms") apply to OpenBots: the OpenBots software, the Mac, iOS and
other apps, the OpenBots website, the shared OpenBots relay, and any other service the OpenBots
project offers (together, "OpenBots" or the "Service"). "We", "us" and "our" mean the OpenBots
project and its maintainers. "You" means the person or organization using OpenBots.

**By installing, running, accessing or otherwise using OpenBots, you confirm that you have read,
understood and accepted these Terms.** If you do not accept them, do not use OpenBots. If you use
OpenBots on behalf of an organization, you accept these Terms for that organization and confirm
you have the authority to do so.

## 1. Summary

This summary is part of the Terms, but the full sections below control.

- **You are responsible for your Bots.** OpenBots is not liable for any action a Bot takes, any
  output it produces, or any consequence of either.
- **The shared relay comes with no promises.** It is provided for free, with no guarantee of
  availability, uptime or latency, and it may change, be limited or be shut down at any time.
- **Using OpenBots means you accept these Terms.**

## 2. The software license

The OpenBots source code is licensed under the [Business Source License 1.1](../LICENSE), and the
`ee/` directory under [ee/LICENSE](../ee/LICENSE). Those licenses govern your rights to use,
copy, change and distribute the code. These Terms add to the licenses and do not reduce any right
they grant. If these Terms and a license conflict about the code itself, the license controls.

## 3. Bots and their actions

OpenBots lets you create Bots that act on your behalf. Bots can run commands on a computer,
browse the web, call tools and MCP servers, send messages, handle webhooks, run Routines without
you present, and work with other Bots. Bots are driven by AI models that you choose and that
OpenBots does not control.

You understand and agree that:

1. **OpenBots is not liable for actions taken by Bots.** Every action a Bot takes, including any
   command it runs, file it changes or deletes, message it sends, purchase or transaction it makes,
   account it signs in to, data it reads or shares, and anything it says, is your responsibility,
   not ours. This is true whether the action was one you asked for, one you approved, one a Bot
   took on its own, one a Routine or webhook started, or one another Bot or a third party caused.
2. **AI output can be wrong, harmful or unexpected.** Bots can misunderstand instructions, make
   mistakes, invent facts, follow instructions hidden in web pages, files or messages, and take
   actions you did not intend. Do not rely on a Bot for any decision with legal, medical, financial,
   safety or other serious consequences without checking it yourself.
3. **You control what your Bots can reach.** You decide which tools, credentials, accounts, MCP
   servers, model providers and computers your Bots may use, and which policies and approvals
   apply. Give a Bot only the access you are prepared to have it use, and review what it does.
4. **You must use Bots lawfully.** You will not use OpenBots or your Bots to break any law, infringe
   anyone's rights, send spam, attack or overload systems, get around security controls, or harm
   anyone. You must follow the terms of every model provider, website and service your Bots use.
5. **Safety features are not a guarantee.** OpenBots includes sandboxes, policy gates, approvals
   and other controls. They reduce risk but cannot remove it, and we do not promise they will stop
   every unwanted or harmful action.

## 4. The shared relay

The OpenBots relay lets your phone or other devices reach your OpenBots server when it has no
public address. We run a shared relay that the apps use by default. You can run your own relay
instead (see the [README](../README.md)).

You understand and agree that:

1. **The shared relay is provided for free, as is and as available.** We make no promise or
   commitment of any kind about its availability, uptime, reliability, latency, throughput,
   capacity or performance. It may be slow, drop connections, or be unavailable at any time and
   for any length of time, with or without notice.
2. **The relay may change at any time.** We may change, limit, rate limit, suspend or discontinue
   the shared relay, or any part of it, at any time and for any reason, with or without notice.
   This includes adding usage limits, requiring an account, or charging for it in the future.
3. **We may restrict access.** We may block or disconnect any server or device from the shared
   relay at any time, including for abuse, excessive use, or to protect the relay or its users.
4. **Do not depend on it for anything critical.** If you need guaranteed availability or
   performance, run your own relay or give your server a direct address.
5. **What the relay sees.** Traffic between your devices and your server is end to end encrypted
   with keys the relay never holds. The relay sees your server's id, when it is connected, and how
   many streams and bytes pass through it, but not what they carry. Push notifications sent through
   the shared relay pass through Apple's push service.

## 5. Free services and changes to the Service

OpenBots, the apps and the shared relay are currently offered free of charge, except where a
separate paid plan or agreement says otherwise. We may change, add or remove any feature, or
change, suspend or stop any part of the Service, at any time, with or without notice. We may also
introduce fees for services that are free today. We are not liable to you or anyone else for any
such change.

## 6. Your responsibilities

You are responsible for:

- The machines, servers and accounts you run OpenBots on, and keeping them secure.
- Your master key, passwords, API keys and other credentials, and backing up your data.
  If you lose your master key, your stored secrets cannot be recovered.
- The costs of your hosting, model providers and any third party services your Bots use.
- Everything you and your Bots put into, or produce with, OpenBots, and having the rights to it.

## 7. Third party services

OpenBots connects to services we do not run, such as AI model providers, MCP servers, cloud
hosts, app stores and push notification services. Your use of them is governed by their own terms
and privacy policies. We are not responsible for them, for their availability, or for what they
do with your data.

## 8. Disclaimer of warranties

TO THE FULLEST EXTENT ALLOWED BY LAW, OPENBOTS, INCLUDING THE SOFTWARE, THE APPS, THE SHARED
RELAY AND ANY OTHER SERVICE, IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTIES OF ANY
KIND, WHETHER EXPRESS, IMPLIED OR STATUTORY, INCLUDING ANY WARRANTY OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE, TITLE, NON INFRINGEMENT, ACCURACY, SECURITY, AVAILABILITY OR THAT THE
SERVICE WILL BE UNINTERRUPTED OR ERROR FREE. WE DO NOT WARRANT THAT ANY BOT OR AI MODEL WILL
BEHAVE AS YOU EXPECT OR THAT ITS OUTPUT WILL BE CORRECT OR SAFE.

## 9. Limitation of liability

TO THE FULLEST EXTENT ALLOWED BY LAW, NEITHER THE OPENBOTS PROJECT NOR ITS MAINTAINERS OR
CONTRIBUTORS WILL BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY OR
PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, DATA, GOODWILL OR BUSINESS, ARISING OUT
OF OR RELATING TO OPENBOTS, THESE TERMS, ANY ACTION TAKEN BY A BOT, ANY AI OUTPUT, OR ANY
UNAVAILABILITY, DELAY OR FAILURE OF THE SHARED RELAY, EVEN IF WE WERE TOLD SUCH DAMAGES WERE
POSSIBLE. OUR TOTAL LIABILITY FOR ALL CLAIMS RELATING TO OPENBOTS WILL NOT EXCEED THE GREATER OF
THE AMOUNT YOU PAID US FOR OPENBOTS IN THE 12 MONTHS BEFORE THE CLAIM AND US$50.

Some places do not allow some of these exclusions or limits. In those places, they apply only as
far as the law allows.

## 10. Indemnity

To the extent allowed by law, you will defend, indemnify and hold harmless the OpenBots project,
its maintainers and contributors from any claim, loss, liability or expense (including reasonable
legal fees) arising from your use of OpenBots, any action taken by your Bots, the content you or
your Bots create, or your breach of these Terms or of any law.

## 11. Ending your use

You may stop using OpenBots at any time. We may suspend or end your access to any service we run,
including the shared relay, at any time. Sections 3, 4, 8, 9, 10 and 12 continue to apply after
your use ends.

## 12. General

- **Changes to these Terms.** We may update these Terms at any time. The "Last updated" date shows
  when they last changed. Continuing to use OpenBots after an update means you accept the updated
  Terms.
- **Severability.** If any part of these Terms is found unenforceable, the rest stays in effect.
- **No waiver.** Not enforcing a part of these Terms is not a waiver of it.
- **Entire agreement.** These Terms, together with the software licenses and any separate written
  agreement with us, are the whole agreement between you and us about OpenBots.

## 13. Contact

Questions about these Terms can be raised as an issue on the
[OpenBots GitHub repository](https://github.com/danielpang/OpenBots/issues). Report security
issues privately as described in [SECURITY.md](SECURITY.md).
