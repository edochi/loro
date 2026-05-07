export * from "./loro_wasm";
export type * from "./loro_wasm";
import { AwarenessWasm, EphemeralStoreWasm, PeerID, Container, ContainerID, ContainerType, LoroCounter, LoroDoc, LoroList, LoroMap, LoroText, LoroTree, OpId, Value, AwarenessListener, EphemeralListener, EphemeralLocalListener } from "./loro_wasm";
/**
 * @deprecated Please use LoroDoc
 */
export declare class Loro extends LoroDoc {
}
export declare function isContainerId(s: string): s is ContainerID;
/**  Whether the value is a container.
 *
 * # Example
 *
 * ```ts
 * const doc = new LoroDoc();
 * const map = doc.getMap("map");
 * const list = doc.getList("list");
 * const text = doc.getText("text");
 * isContainer(map); // true
 * isContainer(list); // true
 * isContainer(text); // true
 * isContainer(123); // false
 * isContainer("123"); // false
 * isContainer({}); // false
 * ```
 */
export declare function isContainer(value: any): value is Container;
/**  Get the type of a value that may be a container.
 *
 * # Example
 *
 * ```ts
 * const doc = new LoroDoc();
 * const map = doc.getMap("map");
 * const list = doc.getList("list");
 * const text = doc.getText("text");
 * getType(map); // "Map"
 * getType(list); // "List"
 * getType(text); // "Text"
 * getType(123); // "Json"
 * getType("123"); // "Json"
 * getType({}); // "Json"
 * ```
 */
export declare function getType<T>(value: T): T extends LoroText ? "Text" : T extends LoroMap<any> ? "Map" : T extends LoroTree<any> ? "Tree" : T extends LoroList<any> ? "List" : T extends LoroCounter ? "Counter" : "Json";
export declare function newContainerID(id: OpId, type: ContainerType): ContainerID;
export declare function newRootContainerID(name: string, type: ContainerType): ContainerID;
/**
 * @deprecated Please use `EphemeralStore` instead.
 *
 * Awareness is a structure that allows to track the ephemeral state of the peers.
 *
 * If we don't receive a state update from a peer within the timeout, we will remove their state.
 * The timeout is in milliseconds. This can be used to handle the offline state of a peer.
 */
export declare class Awareness<T extends Value = Value> {
    inner: AwarenessWasm<T>;
    private peer;
    private timer;
    private timeout;
    private listeners;
    constructor(peer: PeerID, timeout?: number);
    apply(bytes: Uint8Array, origin?: string): void;
    setLocalState(state: T): void;
    getLocalState(): T | undefined;
    getAllStates(): Record<PeerID, T>;
    encode(peers: PeerID[]): Uint8Array;
    encodeAll(): Uint8Array;
    addListener(listener: AwarenessListener): void;
    removeListener(listener: AwarenessListener): void;
    peers(): PeerID[];
    destroy(): void;
    private startTimerIfNotEmpty;
}
/**
 * EphemeralStore tracks ephemeral key-value state across peers.
 *
 * - Use it for lightweight presence/state like cursors, selections, and UI hints.
 * - Conflict resolution is timestamp-based LWW (Last-Write-Wins) per key.
 * - Timeout unit: milliseconds.
 * - After timeout: keys are considered expired. They are omitted from
 *   `encode(key)`, `encodeAll()` and `getAllStates()`. A periodic cleanup runs
 *   while the store is non-empty and removes expired keys; when removals happen
 *   subscribers receive an event with `by: "timeout"` and the `removed` keys.
 *
 * See: https://loro.dev/docs/tutorial/ephemeral
 *
 * @param timeout Inactivity timeout in milliseconds (default: 30000). If a key
 * doesn't receive updates within this duration, it will expire and be removed
 * on the next cleanup tick.
 *
 * @example
 * ```ts
 * const store = new EphemeralStore();
 * const store2 = new EphemeralStore();
 * // Subscribe to local updates and forward over the wire
 * store.subscribeLocalUpdates((data) => {
 *   store2.apply(data);
 * });
 * // Subscribe to all updates (including removals by timeout)
 * store2.subscribe((event) => {
 *   console.log("event:", event);
 * });
 * // Set a value
 * store.set("key", "value");
 * // Encode the value
 * const encoded = store.encode("key");
 * // Apply the encoded value
 * store2.apply(encoded);
 * ```
 */
export declare class EphemeralStore<T extends Record<string, Value> = Record<string, Value>> {
    inner: EphemeralStoreWasm;
    private timer;
    private timeout;
    constructor(timeout?: number);
    apply(bytes: Uint8Array): void;
    set<K extends keyof T>(key: K, value: T[K]): void;
    delete<K extends keyof T>(key: K): void;
    get<K extends keyof T>(key: K): T[K] | undefined;
    getAllStates(): Partial<T>;
    encode<K extends keyof T>(key: K): Uint8Array;
    encodeAll(): Uint8Array;
    keys(): string[];
    destroy(): void;
    subscribe(listener: EphemeralListener): () => void;
    subscribeLocalUpdates(listener: EphemeralLocalListener): () => void;
    private startTimerIfNotEmpty;
}
export declare function idStrToId(idStr: `${number}@${PeerID}`): OpId;
