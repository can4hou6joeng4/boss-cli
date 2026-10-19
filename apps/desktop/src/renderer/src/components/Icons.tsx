import React from "react";

export interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
}

export const IconPanel: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <line x1="6.5" y1="2.5" x2="6.5" y2="13.5" />
  </svg>
);

export const IconPanelRight: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <line x1="9.5" y1="2.5" x2="9.5" y2="13.5" />
  </svg>
);

export const IconMore: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...props}>
    <circle cx="3.5" cy="8" r="1.2" />
    <circle cx="8" cy="8" r="1.2" />
    <circle cx="12.5" cy="8" r="1.2" />
  </svg>
);

export const IconNotification: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4 6a4 4 0 0 1 8 0c0 4 1.5 5 1.5 5H2.5S4 10 4 6Z" />
    <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0" />
  </svg>
);

export const IconSearch: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="7" cy="7" r="4.5" />
    <line x1="10.5" y1="10.5" x2="14" y2="14" />
  </svg>
);

export const IconNewChat: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 3.5h7.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
    <path d="M13.5 2.5 9.5 6.5" />
    <path d="M12.5 1.5 14.5 3.5" />
  </svg>
);

export const IconFolder: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M2 3.5a1 1 0 0 1 1-1h3.2a1 1 0 0 1 .7.3l1.2 1.2a1 1 0 0 0 .7.3H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5Z" />
  </svg>
);

export const IconChevronRight: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="6 3.5 10.5 8 6 12.5" />
  </svg>
);

export const IconChevronDown: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="3.5 6 8 10.5 12.5 6" />
  </svg>
);

export const IconPlay: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...props}>
    <polygon points="5 3.5 13 8 5 12.5 5 3.5" />
  </svg>
);

export const IconPlus: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <line x1="8" y1="3.5" x2="8" y2="12.5" />
    <line x1="3.5" y1="8" x2="12.5" y2="8" />
  </svg>
);

export const IconSend: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <line x1="8" y1="12" x2="8" y2="4" />
    <polyline points="4.5 7.5 8 4 11.5 7.5" />
  </svg>
);

export const IconCopy: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="5" y="5" width="8" height="8" rx="1.5" />
    <path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3" />
  </svg>
);

export const IconThumbsUp: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4.5 7H2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h2.5" />
    <path d="M4.5 14h7a1.5 1.5 0 0 0 1.5-1.2l1-4.8a1.5 1.5 0 0 0-1.5-1.8H9V3.5a1.5 1.5 0 0 0-3 0V7" />
  </svg>
);

export const IconThumbsDown: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4.5 9H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h2.5" />
    <path d="M4.5 2h7a1.5 1.5 0 0 1 1.5 1.2l1 4.8a1.5 1.5 0 0 1-1.5 1.8H9v2.7a1.5 1.5 0 0 1-3 0V9" />
  </svg>
);

export const IconHistory: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="8" cy="8" r="6" />
    <polyline points="8 4.5 8 8 10.5 9.5" />
  </svg>
);

export const IconHome: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M2.5 6.5 8 2.5l5.5 4v6.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1v-6.5Z" />
    <path d="M6 14V8.5h4V14" />
  </svg>
);

export const IconHelp: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.2 6.2a2 2 0 0 1 3.6 1c0 1.2-1.8 1.5-1.8 2.3" />
    <circle cx="8" cy="11.8" r="0.5" fill="currentColor" />
  </svg>
);

export const IconSettings: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="8" cy="8" r="2.5" />
    <path d="M13.8 6.5 13 5.3l-1.3.4a4.8 4.8 0 0 0-.9-.9l.4-1.3L10 2.7l-.8 1a5 5 0 0 0-1.2 0l-.8-1-1.2.8.4 1.3a4.8 4.8 0 0 0-.9.9L4.2 5.3 3.4 6.5l1 .8a5 5 0 0 0 0 1.2l-1 .8.8 1.2 1.3-.4a4.8 4.8 0 0 0 .9.9l-.4 1.3 1.2.8.8-1a5 5 0 0 0 1.2 0l.8 1 1.2-.8-.4-1.3a4.8 4.8 0 0 0 .9-.9l1.3.4.8-1.2-1-.8a5 5 0 0 0 0-1.2l1-.8Z" />
  </svg>
);

export const IconUser: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="8" cy="5" r="3" />
    <path d="M3 13.5c0-2.5 2.2-4.5 5-4.5s5 2 5 4.5" />
  </svg>
);

export const IconUndo: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M2.5 5.5h7a3.5 3.5 0 0 1 0 7H5" />
    <polyline points="5 3 2.5 5.5 5 8" />
  </svg>
);

export const IconDiffFiles: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 2.5a1 1 0 0 1 1-1h5l3 3V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.5Z" />
    <path d="M9 1.5V4.5H12" />
    <line x1="5.5" y1="7.5" x2="10.5" y2="7.5" />
    <line x1="5.5" y1="10" x2="8.5" y2="10" />
  </svg>
);

export const IconLock: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3.5" y="6.5" width="9" height="7.5" rx="1.5" />
    <path d="M5.5 6.5V4.5a2.5 2.5 0 0 1 5 0v2" />
  </svg>
);

export const IconCheck: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
  </svg>
);

export const IconSun: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="8" cy="8" r="3" />
    <line x1="8" y1="1.5" x2="8" y2="3.5" />
    <line x1="8" y1="12.5" x2="8" y2="14.5" />
    <line x1="1.5" y1="8" x2="3.5" y2="8" />
    <line x1="12.5" y1="8" x2="14.5" y2="8" />
  </svg>
);

export const IconMoon: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M13.5 9.5a5.5 5.5 0 1 1-7-7 4.5 4.5 0 0 0 7 7Z" />
  </svg>
);

export const IconTerminal: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="3.5 5 6.5 8 3.5 11" />
    <line x1="8.5" y1="11" x2="12.5" y2="11" />
  </svg>
);

export const IconCockpit: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="8" cy="8" r="6" />
    <line x1="8" y1="8" x2="11" y2="5" />
    <circle cx="8" cy="8" r="1.5" fill="currentColor" />
  </svg>
);

export const IconChat: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M2.5 4.5A2 2 0 0 1 4.5 2.5h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-4L4 14v-2.5h-.5a2 2 0 0 1-2-2v-5Z" />
  </svg>
);

export const IconSparkles: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M8 1.5 9.5 6 14 7.5 9.5 9 8 13.5 6.5 9 2 7.5 6.5 6 8 1.5Z" />
    <path d="M12.5 1.5 13 3 14.5 3.5 13 4 12.5 5.5 12 4 10.5 3.5 12 3 12.5 1.5Z" />
  </svg>
);

export const IconClock: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="8" cy="8" r="6" />
    <polyline points="8 4.5 8 8 10.5 8" />
  </svg>
);

export const IconClose: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <line x1="4" y1="4" x2="12" y2="12" />
    <line x1="12" y1="4" x2="4" y2="12" />
  </svg>
);

export const IconPause: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...props}>
    <rect x="4" y="3.5" width="2.5" height="9" rx="1" />
    <rect x="9.5" y="3.5" width="2.5" height="9" rx="1" />
  </svg>
);

export const IconStop: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...props}>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
  </svg>
);

export const IconShield: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M8 2 3 4v4.5c0 3.5 2.5 5.5 5 6.5 2.5-1 5-3 5-6.5V4L8 2Z" />
  </svg>
);

export const IconBranch: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="4" cy="4" r="1.5" />
    <circle cx="4" cy="12" r="1.5" />
    <circle cx="12" cy="7" r="1.5" />
    <line x1="4" y1="5.5" x2="4" y2="10.5" />
    <path d="M4 8.5a4 4 0 0 0 4-2.5h2.5" />
  </svg>
);

export const IconRewind: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M2.5 7.5A5.5 5.5 0 1 1 5 12" />
    <polyline points="2.5 4 2.5 7.5 6 7.5" />
  </svg>
);

export const IconQuote: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...props}>
    <path d="M3.5 10.5c0 1.1.9 2 2 2s2-.9 2-2V8a2 2 0 0 0-2-2h-.5c.3-1.4 1.5-2.5 3-2.5V2C5.5 2 3.5 4 3.5 8v2.5Zm6.5 0c0 1.1.9 2 2 2s2-.9 2-2V8a2 2 0 0 0-2-2h-.5c.3-1.4 1.5-2.5 3-2.5V2C12 2 10 4 10 8v2.5Z" />
  </svg>
);

export const IconEdit: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M11.5 2.5a1.5 1.5 0 0 1 2 2L5 13H2.5v-2.5l9-9Z" />
  </svg>
);

export const IconExternalLink: React.FC<IconProps> = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M10 2.5h3.5V6" />
    <line x1="6.5" y1="9.5" x2="13.5" y2="2.5" />
    <path d="M11.5 8.5V13a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h4.5" />
  </svg>
);
