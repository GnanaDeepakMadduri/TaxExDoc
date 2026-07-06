/**
 * Toast.jsx — Notification toasts
 */
export default function Toast({ toasts, onRemove }) {
  if (!toasts.length) return null;

  return (
    <div className="toast-stack">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`toast toast-${t.type}`}
          onClick={() => onRemove(t.id)}
          role="alert"
        >
          <span className="toast-indicator" />
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
