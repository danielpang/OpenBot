// Stands in for @tanstack/react-router in the office bundle: opening a Bot asks the app.
export function useNavigate() {
  return (to: { params?: { botId?: string } }) => {
    const botId = to.params?.botId;
    if (botId) window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'open', botId }));
    return Promise.resolve();
  };
}
