import { BotStateKindSchema } from '@openbots/shared';

// Motion states (I2, plan 13). The avatar is the status indicator: no badge.
// Poses (where the eyes look, a squint) use the individual `translate` and
// `scale` properties; motion uses `transform` keyframes on top. Reduced
// motion turns the keyframes off, keeps the pose, and adds a coloured ring.

export const AVATAR_STATES = BotStateKindSchema.options;
export type AvatarState = (typeof AVATAR_STATES)[number];

/** The ring colour each state shows under reduced motion and around uploaded images. */
export const STATE_RING: Record<AvatarState, string> = {
  idle: 'transparent',
  thinking: '#8B5CF6',
  working: '#3B82F6',
  waiting: '#F59E0B',
  blocked: '#9CA3AF',
  done: '#22C55E',
};

const s = (state: AvatarState) => `.ob-avatar[data-state=${state}]`;

export const AVATAR_CSS = `
.ob-avatar{position:relative;display:inline-block;flex-shrink:0;line-height:0;border-radius:9999px;vertical-align:middle}
.ob-avatar>svg,.ob-avatar>img{width:100%;height:100%;overflow:visible}
.ob-avatar>img{object-fit:cover;border-radius:9999px}
.ob-avatar .ob-figure,.ob-avatar .ob-eyes,.ob-avatar .ob-eye,.ob-avatar .ob-pupil{transform-box:fill-box;transform-origin:center}
.ob-avatar .ob-figure{transform-origin:50% 100%}
.ob-avatar .ob-eyes,.ob-avatar .ob-pupil,.ob-avatar .ob-eye{transition:translate .4s ease,scale .3s ease}
${ringRules()}
${s('idle')} .ob-figure{animation:ob-breathe 4.8s ease-in-out infinite}
${s('idle')} .ob-eye{animation:ob-blink 5.6s infinite}
${s('idle')} .ob-eyes{animation:ob-drift 9s ease-in-out infinite}
${s('thinking')} .ob-eyes{translate:1px -3.5px}
${s('thinking')} .ob-figure{animation:ob-tilt 3.2s ease-in-out infinite}
${s('thinking')} .ob-eye{animation:ob-blink 7s infinite}
${s('working')} .ob-figure{animation:ob-bob .7s ease-in-out infinite}
${s('working')} .ob-eye{scale:1 .72}
${s('working')} .ob-pupil{scale:.85}
${s('waiting')} .ob-pupil{scale:1.15}
${s('waiting')} .ob-figure{animation:ob-bounce 1.8s ease-out infinite}
${s('blocked')} .ob-eyes{translate:0 3.5px}
${s('blocked')}>svg,${s('blocked')}>img{filter:saturate(.25);opacity:.8}
${s('done')} .ob-figure{animation:ob-settle .9s ease-out 1 both}
${s('done')} .ob-eye{scale:1 .8}
.ob-avatar[data-kind=upload][data-state=thinking],.ob-avatar[data-kind=upload][data-state=working]{animation:ob-pulse 1.4s ease-in-out infinite}
.ob-avatar[data-kind=upload][data-state=waiting]{animation:ob-bounce 1.8s ease-out infinite}
.ob-avatar[data-motion=reduced],.ob-avatar[data-motion=reduced] *{animation:none!important;transition:none!important}
.ob-avatar[data-motion=reduced]:not([data-state=idle]){box-shadow:0 0 0 2px var(--ob-ring)}
@media (prefers-reduced-motion:reduce){
.ob-avatar,.ob-avatar *{animation:none!important;transition:none!important}
.ob-avatar:not([data-state=idle]){box-shadow:0 0 0 2px var(--ob-ring)}
}
@keyframes ob-breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.02,1.04)}}
@keyframes ob-blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}
@keyframes ob-drift{0%,100%{transform:translateX(0)}30%{transform:translateX(1.5px)}65%{transform:translateX(-1.5px)}}
@keyframes ob-tilt{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(-3deg)}}
@keyframes ob-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2.5px)}}
@keyframes ob-bounce{0%,40%,100%{transform:translateY(0)}15%{transform:translateY(-3px)}28%{transform:translateY(.5px)}}
@keyframes ob-settle{0%{transform:scale(1.1,.9)}45%{transform:scale(.96,1.05)}100%{transform:scale(1,1)}}
@keyframes ob-pulse{0%,100%{box-shadow:0 0 0 2px var(--ob-ring)}50%{box-shadow:0 0 0 3.5px var(--ob-ring)}}
`.trim();

function ringRules(): string {
  return AVATAR_STATES.map((state) => `${s(state)}{--ob-ring:${STATE_RING[state]}}`)
    .concat('.ob-avatar[data-kind=upload]{box-shadow:0 0 0 2px var(--ob-ring)}')
    .join('\n');
}
