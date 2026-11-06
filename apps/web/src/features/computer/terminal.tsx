import { COMPUTER_OFF_CLOSE_CODE } from '@openbots/shared';
import { Button } from '@openbots/ui';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { ptyUrl, type PtyAttach } from './api.js';
import { useRefreshComputer } from './live.js';

// The Computer page's terminal (K1, plan 9.3): xterm.js over the server's
// `/computer/pty` proxy to a login shell on the computer. Frames are the
// agent's JSON messages: `input` and `resize` out, `output` and `exit` in.
// The proxy never starts the computer; if it is off, the socket closes with
// COMPUTER_OFF_CLOSE_CODE and the page refetches the computer's state.
// `attach` opens it in a directory, as another user, with a command typed
// (Open terminal on a coding session or a repository, CA7, I15); a new
// attach opens a new session.

type Phase = 'connecting' | 'open' | 'closed' | 'off';

type PtyMessage = { type: 'output'; data: string } | { type: 'exit'; exitCode: number };

export function ComputerTerminal({ attach }: { attach?: PtyAttach } = {}) {
  const cwd = attach?.cwd;
  const user = attach?.user;
  const preset = attach?.preset;
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [session, setSession] = useState(0);
  const refresh = useRefreshComputer();

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();

    setPhase('connecting');
    const socket = new WebSocket(ptyUrl(term.cols, term.rows, { cwd, user, preset }));
    const send = (message: object) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    socket.onopen = () => {
      setPhase('open');
      term.focus();
    };
    socket.onmessage = (event: MessageEvent) => {
      let message: PtyMessage;
      try {
        message = JSON.parse(String(event.data)) as PtyMessage;
      } catch {
        return;
      }
      if (message.type === 'output') term.write(message.data);
      else if (message.type === 'exit') term.write(`\r\n[exited with ${message.exitCode}]\r\n`);
    };
    socket.onclose = (event: CloseEvent) => {
      if (event.code !== COMPUTER_OFF_CLOSE_CODE) return setPhase('closed');
      setPhase('off');
      void refresh();
    };

    const input = term.onData((data) => send({ type: 'input', data }));
    const resize = term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current);

    return () => {
      observer.disconnect();
      input.dispose();
      resize.dispose();
      socket.onclose = null;
      socket.close();
      term.dispose();
    };
  }, [session, refresh, cwd, user, preset]);

  return (
    <div className="flex flex-col gap-2">
      <div ref={host} className="h-80 overflow-hidden rounded-md bg-black p-2" />
      {phase !== 'open' && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
          {phase === 'connecting'
            ? 'Connecting…'
            : phase === 'off'
              ? 'The computer is off.'
              : 'The terminal session ended.'}
          {phase === 'closed' && (
            <Button variant="outline" size="sm" onClick={() => setSession((n) => n + 1)}>
              Reconnect
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
