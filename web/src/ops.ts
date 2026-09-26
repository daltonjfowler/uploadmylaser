import type { OpKind } from '../../shared/contracts';

// Same convention students draw with: black = cut, red = mark, blue = engrave.
export const OP_COLORS: Record<OpKind, string> = { cut: '#111827', score: '#dc2626', engrave: '#2563eb' };
export const OP_LABELS: Record<OpKind, string> = { cut: 'Cut through', score: 'Mark', engrave: 'Engrave' };
/** The order the laser runs them. Cut through is always last (parts that fall free can shift). */
export const RUN_ORDER: OpKind[] = ['engrave', 'score', 'cut'];
