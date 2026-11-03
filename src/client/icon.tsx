/**
 * 左侧栏「观象」行的装饰图标；行本身负责可访问名称（列表注册的 label）。
 *
 * @module dsh-logalyze/client/icon
 */

/** Owner share of `sidebar.panellist`: requested square edge and selection state. */
export interface LogalyzeIconProps {
  size: number
  active: boolean
}

/**
 * Eye-over-waveform glyph drawn in `currentColor`.
 * @param props - the sidebar's icon share.
 * @returns decorative icon.
 */
export function LogalyzeIcon({ size }: LogalyzeIconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 10c2.4-3.6 5.6-5.4 9.5-5.4s7.1 1.8 9.5 5.4c-2.4 3.6-5.6 5.4-9.5 5.4S4.9 13.6 2.5 10Z" />
      <circle cx="12" cy="10" r="2.4" />
      <path d="M3 19.5h3l2-2.5 2.5 4 3-6 2.5 4.5 1.5-2h3.5" />
    </svg>
  )
}
