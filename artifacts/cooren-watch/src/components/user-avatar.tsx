export function UserAvatar({ name, url, size = 28, className = '' }: { name: string; url?: string | null; size?: number; className?: string }) {
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.42)) };
  return <span className={`avatar ${className}`} style={style} aria-hidden="true">
    {url ? <img src={url} alt="" loading="lazy" decoding="async" /> : (name[0] || '?').toUpperCase()}
  </span>;
}
