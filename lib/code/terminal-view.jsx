'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import { SpinnerIcon } from '../chat/components/icons.js';

const STATUS = { connected: '#22c55e', connecting: '#eab308', disconnected: '#ef4444' };
const RECONNECT_INTERVAL = 3000;

export default function TerminalView({ codeWorkspaceId, ensureContainer }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);
  const retryTimer = useRef(null);
  const statusRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [containerError, setContainerError] = useState(null);

  const setStatus = useCallback((color) => {
    if (statusRef.current) statusRef.current.style.backgroundColor = color;
    setConnected(color === STATUS.connected);
  }, []);

  const sendResize = useCallback(() => {
    const fit = fitAddonRef.current;
    const ws = wsRef.current;
    const term = termRef.current;
    if (!fit || !term || !ws || ws.readyState !== WebSocket.OPEN) return;
    fit.fit();
    const payload = JSON.stringify({ columns: term.cols, rows: term.rows });
    ws.send('1' + payload);
  }, []);

  const connect = useCallback(() => {
    const term = termRef.current;
    if (!term) return;

    setStatus(STATUS.connecting);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/code/${codeWorkspaceId}/ws`);
    wsRef.current = ws;

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      const handshake = JSON.stringify({ AuthToken: '', columns: term.cols, rows: term.rows });
      ws.send(handshake);
      setStatus(STATUS.connected);
    };

    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
      const type = data[0];
      const payload = data.slice(1);

      switch (type) {
        case '0':
          term.write(payload);
          break;
        case '1':
          document.title = payload || 'Code Workspace';
          break;
        case '2':
          break;
      }
    };

    ws.onclose = () => {
      setStatus(STATUS.disconnected);
      retryTimer.current = setTimeout(connect, RECONNECT_INTERVAL);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [codeWorkspaceId, setStatus]);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 16,
      fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", Menlo, monospace',
      theme: {
        background: '#1a1b26',
        foreground: '#a9b1d6',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const webLinksAddon = new WebLinksAddon();
    const serializeAddon = new SerializeAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(serializeAddon);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.open(containerRef.current);

    const style = document.createElement('style');
    style.textContent = '.xterm { padding: 5px; background-color: #1a1b26 !important; } .xterm-viewport { background-color: #1a1b26 !important; }';
    containerRef.current.appendChild(style);

    fitAddon.fit();

    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send('0' + data);
      }
    });

    let resizeTimeout;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(sendResize, 100);
    };
    window.addEventListener('resize', handleResize);

    let cancelled = false;

    (async () => {
      try {
        const result = await ensureContainer(codeWorkspaceId);
        if (result?.status === 'error') {
          const msg = result.message || 'Unknown container error';
          console.error('ensureContainer:', msg);
          if (!cancelled) setContainerError(msg);
          return;
        }
      } catch (err) {
        console.error('ensureContainer:', err);
        if (!cancelled) setContainerError(err.message || String(err));
        return;
      }
      if (!cancelled) connect();
    })();

    return () => {
      cancelled = true;
      clearTimeout(resizeTimeout);
      clearTimeout(retryTimer.current);
      window.removeEventListener('resize', handleResize);
      if (wsRef.current) wsRef.current.close();
      term.dispose();
    };
  }, [connect, sendResize, codeWorkspaceId]);

  const sendCommand = useCallback((text) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('0' + text + '\r');
    }
  }, []);

  const handleReconnect = async () => {
    clearTimeout(retryTimer.current);
    if (wsRef.current) wsRef.current.close();
    try {
      setContainerError(null);
      const result = await ensureContainer(codeWorkspaceId);
      if (result?.status === 'error') {
        const msg = result.message || 'Unknown container error';
        console.error('ensureContainer:', msg);
        setContainerError(msg);
        return;
      }
    } catch (err) {
      console.error('ensureContainer:', err);
      setContainerError(err.message || String(err));
      return;
    }
    connect();
  };

  const sendTerminalCommand = (cmd) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send('0' + cmd + '\r');
  };

  return (
    <>
      <style>{`
        .code-toolbar-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          color: #7982a9;
          padding: 5px 12px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 12px;
          font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', monospace;
          font-weight: 500;
          letter-spacing: 0.01em;
          transition: all 0.15s ease;
          white-space: nowrap;
          line-height: 1;
        }
        .code-toolbar-btn:hover {
          background: rgba(255,255,255,0.08);
          border-color: rgba(255,255,255,0.15);
          color: #a9b1d6;
        }
        .code-toolbar-btn:active {
          transform: scale(0.97);
        }
        .code-toolbar-btn svg {
          flex-shrink: 0;
        }
        .code-toolbar-btn--commit:hover {
          border-color: rgba(115,218,149,0.3);
          color: #73da95;
          background: rgba(115,218,149,0.08);
        }
        .code-toolbar-btn--merge:hover {
          border-color: rgba(122,162,247,0.3);
          color: #7aa2f7;
          background: rgba(122,162,247,0.08);
        }
        .code-toolbar-btn--reconnect:hover {
          border-color: rgba(169,177,214,0.2);
        }
      `}</style>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div ref={containerRef} className="mx-4" style={{ height: '100%', borderRadius: 6, overflow: 'hidden' }} />
        {(!connected || containerError) && (
          <div style={{
            position: 'absolute',
            top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            background: containerError ? 'rgba(255,235,235,0.95)' : '#1a1b26',
            color: containerError ? '#991b1b' : '#a9b1d6',
            padding: '14px 28px',
            borderRadius: 8,
            fontSize: 13,
            fontFamily: "ui-monospace, 'Cascadia Code', 'Source Code Pro', monospace",
            fontWeight: 500,
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
            zIndex: 10,
            textAlign: 'center',
            maxWidth: 320,
            letterSpacing: '0.02em',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            {containerError
              ? `Container error: ${containerError}`
              : <><SpinnerIcon size={16} /> Loading...</>}
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div
        style={{
          flexShrink: 0,
          height: 42,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          background: '#13141c',
          borderTop: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            className="code-toolbar-btn code-toolbar-btn--commit"
            onClick={() => sendTerminalCommand('/commit -changes')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="8" cy="8" r="3" />
              <line x1="8" y1="1" x2="8" y2="5" />
              <line x1="8" y1="11" x2="8" y2="15" />
            </svg>
            Commit
          </button>
          <button
            className="code-toolbar-btn code-toolbar-btn--merge"
            onClick={() => sendTerminalCommand('/ai -merge')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="4" cy="4" r="2" />
              <circle cx="12" cy="12" r="2" />
              <path d="M4 6v2c0 2.2 1.8 4 4 4h2" />
            </svg>
            Merge
          </button>
        </div>
        <button
          className="code-toolbar-btn code-toolbar-btn--reconnect"
          onClick={handleReconnect}
        >
          <div
            ref={statusRef}
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              backgroundColor: STATUS.connecting,
              boxShadow: `0 0 6px ${STATUS.connecting}`,
              transition: 'all 0.3s ease',
            }}
          />
          Reconnect
        </button>
      </div>
    </>
  );
}
