import { useEffect, useState } from 'react';

export interface ToastProps {
  message: string;
  type?: 'success' | 'error';
  onClose: () => void;
}

export default function Toast({ message, type = 'success', onClose }: ToastProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      onClose();
    }, 3000);

    return () => clearTimeout(timer);
  }, [onClose]);

  if (!visible) return null;

  const bgColor = type === 'success' ? 'bg-green-600' : 'bg-red-600';

  return (
    <div className={`fixed top-4 right-4 z-50 ${bgColor} text-white px-5 py-3 rounded-lg shadow-lg flex items-center gap-3 min-w-[200px] animate-fade-in`}>
      <span className="flex-1 text-sm">{message}</span>
      <button
        onClick={() => {
          setVisible(false);
          onClose();
        }}
        className="text-white/80 hover:text-white text-lg leading-none font-bold"
        aria-label="关闭"
      >
        x
      </button>
    </div>
  );
}
