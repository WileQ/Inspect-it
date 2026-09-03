export type InputKind = 'file' | 'folder' | 'url';

export interface InspectionFile {
  kind: 'file';
  name: string;
  path: string;
  size: number;
  lastModified: number;
  mimeType: string;
  file: File;
}

export interface InspectionFolder {
  kind: 'folder';
  name: string;
  path: string;
  children: InspectionItem[];
}

export interface InspectionUrl {
  kind: 'url';
  name: string;
  path: string;
  url: string;
}

export type InspectionItem = InspectionFile | InspectionFolder | InspectionUrl;

export interface Evidence {
  id: string;
  label: string;
  value: string;
}

export type FindingMethodology = 'fact' | 'heuristic' | 'anomaly' | 'inference' | 'ml';

export interface Finding {
  id: string;
  title: string;
  summary: string;
  severity: 'info' | 'low' | 'medium' | 'high';
  evidence: string[];
  /** What kind of observation this is: measured fact, heuristic rule, statistical anomaly, or inference. */
  methodology?: FindingMethodology;
  /** How much the analyzer trusts this finding. */
  confidence?: 'low' | 'medium' | 'high' | 'measured';
  /** Coarse category for grouping. */
  category?: 'structure' | 'statistics' | 'duplicates' | 'anomaly' | 'metadata' | 'relationships' | 'quality' | 'performance' | 'other';
  /** Extra numeric context used by visualizations / evidence. */
  metrics?: Record<string, number | string>;
}

/** Lightweight, progressive-disclosure visualization data (no chart library). */
export interface Visualization {
  id: string;
  kind: 'bars' | 'histogram' | 'timeline';
  title: string;
  labels: string[];
  values: number[];
  unit?: string;
}

/** A detected relationship between two or more inspected objects. */
export interface ObjectRelationship {
  id: string;
  type: 'duplicate' | 'same-name' | 'same-size' | 'shared-dependency' | 'reference' | 'similar-image' | 'other';
  label: string;
  detail: string;
  objects: string[];
  evidenceIds: string[];
}

export interface AnalysisSection {
  id: string;
  title: string;
  items: Evidence[];
}

export interface IdentitySummary {
  name: string;
  type: string;
  format: string;
  mimeType: string;
  size: number;
  location: string;
  created?: string;
  modified?: string;
  fingerprint: string;
}

export interface AnalysisResult {
  objectKind: InputKind;
  analyzerId: string;
  analyzerName: string;
  capabilities?: string[];
  limitations?: string[];
  targetName: string;
  identity: IdentitySummary;
  sections: AnalysisSection[];
  important: Finding[];
  unusual: Finding[];
  recommendations: Finding[];
  evidence: Evidence[];
  progressLabel: string;
  cacheKey: string;
  generatedAt: string;
  sourceSummary: string;
  visualizations?: Visualization[];
  relationships?: ObjectRelationship[];
}

export interface ProgressSnapshot {
  step: string;
  completed: number;
  total: number;
}

export interface AnalysisSession {
  id: string;
  target: InspectionItem;
  result?: AnalysisResult;
  progress?: ProgressSnapshot;
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  fromCache?: boolean;
}

export interface HistoryEntry {
  id: string;
  targetName: string;
  analyzerName: string;
  cacheKey: string;
  fingerprint: string;
  summary: string;
  result: AnalysisResult;
  createdAt: number;
}

export interface AppSettings {
  bubbleX?: number;
  bubbleY?: number;
  bubbleWidth?: number;
  bubbleHeight?: number;
  panelMode?: boolean;
  showHistory?: boolean;
  detailedReport?: boolean;
  /** Start Inspect It when the user logs in (desktop only, default off). */
  launchAtLogin?: boolean;
  /** Whether the first-launch onboarding card has been dismissed. */
  onboardingSeen?: boolean;
}
