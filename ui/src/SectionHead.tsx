import { DEFAULT_LOOK, Icon, IconTile, LOOK } from './icons';
import type { OnMenu, SectionData } from './rows';

/** Header shared by every section: chevron, icon, title, hidden count and total. */
export function SectionHead(props: { data: SectionData; isOpen: boolean; countText: string | number; onToggle: () => void; onMenu: OnMenu }) {
  const { data, isOpen, countText, onToggle, onMenu } = props;
  const look = LOOK[data.key] ?? DEFAULT_LOOK;
  return (
    <button className="section-head" data-nav="1" data-section="1" onClick={onToggle} onContextMenu={(e) => onMenu(e, data, null)} aria-expanded={isOpen}>
      <span className={`chev ${isOpen ? 'open' : ''}`}>
        <Icon name="chevron" size={14} />
      </span>
      <IconTile name={look.icon} hue={look.hue} />
      <span className="section-title">{data.title}</span>
      {data.hidden > 0 && <span className="muted small">{data.hidden} hidden</span>}
      <span className="count">{countText}</span>
    </button>
  );
}
