export interface ExcalidrawElementBase {
    id: string;
    type: ExcalidrawElementType;
    x: number;
    y: number;
    width?: number;
    height?: number;
    angle?: number;
    strokeColor?: string;
    backgroundColor?: string;
    fillStyle?: string;
    strokeWidth?: number;
    strokeStyle?: string;
    roughness?: number;
    opacity?: number;
    groupIds?: string[];
    frameId?: string | null;
    roundness?: {
        type: number;
        value?: number;
    } | null;
    seed?: number;
    versionNonce?: number;
    isDeleted?: boolean;
    locked?: boolean;
    link?: string | null;
    customData?: Record<string, any> | null;
    boundElements?: readonly ExcalidrawBoundElement[] | null;
    updated?: number;
    containerId?: string | null;
}
export interface ExcalidrawTextElement extends ExcalidrawElementBase {
    type: 'text';
    text: string;
    fontSize?: number;
    fontFamily?: number;
    textAlign?: string;
    verticalAlign?: string;
    baseline?: number;
    lineHeight?: number;
}
export interface ExcalidrawRectangleElement extends ExcalidrawElementBase {
    type: 'rectangle';
    width: number;
    height: number;
}
export interface ExcalidrawEllipseElement extends ExcalidrawElementBase {
    type: 'ellipse';
    width: number;
    height: number;
}
export interface ExcalidrawDiamondElement extends ExcalidrawElementBase {
    type: 'diamond';
    width: number;
    height: number;
}
export interface ExcalidrawArrowElement extends ExcalidrawElementBase {
    type: 'arrow';
    points: readonly [number, number][];
    lastCommittedPoint?: readonly [number, number] | null;
    startBinding?: ExcalidrawBinding | null;
    endBinding?: ExcalidrawBinding | null;
    startArrowhead?: string | null;
    endArrowhead?: string | null;
}
export interface ExcalidrawLineElement extends ExcalidrawElementBase {
    type: 'line';
    points: readonly [number, number][];
    lastCommittedPoint?: readonly [number, number] | null;
    startBinding?: ExcalidrawBinding | null;
    endBinding?: ExcalidrawBinding | null;
}
export interface ExcalidrawFreedrawElement extends ExcalidrawElementBase {
    type: 'freedraw';
    points: readonly [number, number][];
    pressures?: readonly number[];
    simulatePressure?: boolean;
    lastCommittedPoint?: readonly [number, number] | null;
}
export type ExcalidrawElement = ExcalidrawTextElement | ExcalidrawRectangleElement | ExcalidrawEllipseElement | ExcalidrawDiamondElement | ExcalidrawArrowElement | ExcalidrawLineElement | ExcalidrawFreedrawElement;
export interface ExcalidrawBoundElement {
    id: string;
    type: 'text' | 'arrow';
}
export interface ExcalidrawBinding {
    elementId: string;
    focus: number;
    gap: number;
    fixedPoint?: readonly [number, number] | null;
}
export type ExcalidrawElementType = 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'text' | 'line' | 'freedraw' | 'image';
export declare const EXCALIDRAW_ELEMENT_TYPES: Record<string, ExcalidrawElementType>;
export interface ServerElement extends Omit<ExcalidrawElementBase, 'id'> {
    id: string;
    type: ExcalidrawElementType;
    createdAt?: string;
    updatedAt?: string;
    version?: number;
    syncedAt?: string;
    source?: string;
    syncTimestamp?: string;
    text?: string;
    originalText?: string;
    fontSize?: number;
    fontFamily?: string | number;
    label?: {
        text: string;
    };
    points?: any;
    start?: {
        id: string;
    };
    end?: {
        id: string;
    };
}
export interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    error?: string;
    message?: string;
}
export interface ElementsResponse extends ApiResponse {
    elements: ServerElement[];
    count: number;
}
export interface ElementResponse extends ApiResponse {
    element: ServerElement;
}
export interface SyncResponse extends ApiResponse {
    count: number;
    syncedAt: string;
    beforeCount: number;
    afterCount: number;
}
export interface WebSocketMessage {
    type: WebSocketMessageType;
    [key: string]: any;
}
export type WebSocketMessageType = 'initial_elements' | 'element_created' | 'element_updated' | 'element_deleted' | 'elements_batch_created' | 'elements_synced' | 'sync_status' | 'mermaid_convert' | 'canvas_cleared' | 'export_image_request' | 'set_viewport' | 'files_added' | 'file_deleted';
export interface InitialElementsMessage extends WebSocketMessage {
    type: 'initial_elements';
    elements: ServerElement[];
}
export interface ElementCreatedMessage extends WebSocketMessage {
    type: 'element_created';
    element: ServerElement;
}
export interface ElementUpdatedMessage extends WebSocketMessage {
    type: 'element_updated';
    element: ServerElement;
}
export interface ElementDeletedMessage extends WebSocketMessage {
    type: 'element_deleted';
    elementId: string;
}
export interface BatchCreatedMessage extends WebSocketMessage {
    type: 'elements_batch_created';
    elements: ServerElement[];
}
export interface SyncStatusMessage extends WebSocketMessage {
    type: 'sync_status';
    elementCount: number;
    timestamp: string;
}
export interface MermaidConvertMessage extends WebSocketMessage {
    type: 'mermaid_convert';
    mermaidDiagram: string;
    config?: MermaidConfig;
    timestamp: string;
}
export interface MermaidConfig {
    startOnLoad?: boolean;
    flowchart?: {
        curve?: 'linear' | 'basis';
    };
    themeVariables?: {
        fontSize?: string;
    };
    maxEdges?: number;
    maxTextSize?: number;
}
export interface MermaidConversionRequest {
    mermaidDiagram: string;
    config?: MermaidConfig;
}
export interface MermaidConversionResponse extends ApiResponse {
    elements: ServerElement[];
    files?: any;
    count: number;
}
export interface CanvasClearedMessage extends WebSocketMessage {
    type: 'canvas_cleared';
    timestamp: string;
}
export interface ExportImageRequestMessage extends WebSocketMessage {
    type: 'export_image_request';
    requestId: string;
    format: 'png' | 'svg';
    background?: boolean;
}
export interface SetViewportMessage extends WebSocketMessage {
    type: 'set_viewport';
    requestId: string;
    scrollToContent?: boolean;
    scrollToElementId?: string;
    zoom?: number;
    offsetX?: number;
    offsetY?: number;
}
export interface Snapshot {
    name: string;
    elements: ServerElement[];
    createdAt: string;
}
export declare const elements: Map<string, ServerElement>;
export declare const snapshots: Map<string, Snapshot>;
export interface ExcalidrawFile {
    id: string;
    dataURL: string;
    mimeType: string;
    created: number;
}
export declare const files: Map<string, ExcalidrawFile>;
export declare function validateElement(element: Partial<ServerElement>): element is ServerElement;
export declare function generateId(): string;
export declare function normalizeFontFamily(fontFamily: string | number | undefined): number | undefined;
//# sourceMappingURL=types.d.ts.map