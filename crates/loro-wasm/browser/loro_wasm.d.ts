/* tslint:disable */
/* eslint-disable */
/**
 * Redacts sensitive content in JSON updates within the specified version range.
 *
 * This function allows you to share document history while removing potentially sensitive content.
 * It preserves the document structure and collaboration capabilities while replacing content with
 * placeholders according to these redaction rules:
 *
 * - Preserves delete and move operations
 * - Replaces text insertion content with the Unicode replacement character
 * - Substitutes list and map insert values with null
 * - Maintains structure of child containers
 * - Replaces text mark values with null
 * - Preserves map keys and text annotation keys
 *
 * @param {Object|string} jsonUpdates - The JSON updates to redact (object or JSON string)
 * @param {Object} versionRange - Version range defining what content to redact,
 *                  format: { peerId: [startCounter, endCounter], ... }
 * @returns {Object} The redacted JSON updates
 */
export function redactJsonUpdates(json_updates: string | JsonSchema, version_range: any): JsonSchema;
export function decodeFrontiers(bytes: Uint8Array): { peer: PeerID, counter: number }[];
export function encodeFrontiers(frontiers: ({ peer: PeerID, counter: number })[]): Uint8Array;
/**
 * Decode the metadata of the import blob.
 *
 * This method is useful to get the following metadata of the import blob:
 *
 * - startVersionVector
 * - endVersionVector
 * - startTimestamp
 * - endTimestamp
 * - mode
 * - changeNum
 */
export function decodeImportBlobMeta(blob: Uint8Array, check_checksum: boolean): ImportBlobMetadata;
/**
 * Get the version of Loro
 */
export function LORO_VERSION(): string;
export function run(): void;
export function callPendingEvents(): void;
/**
 * Enable debug info of Loro
 */
export function setDebug(): void;

/**
* Container types supported by loro.
*
* It is most commonly used to specify the type of sub-container to be created.
* @example
* ```ts
* import { LoroDoc, LoroText } from "loro-crdt";
*
* const doc = new LoroDoc();
* const list = doc.getList("list");
* list.insert(0, 100);
* const text = list.insertContainer(1, new LoroText());
* ```
*/
export type ContainerType = "Text" | "Map" | "List"| "Tree" | "MovableList" | "Counter";

export type PeerID = `${number}`;
export type TextPosType = "unicode" | "utf16" | "utf8";
/**
* The unique id of each container.
*
* @example
* ```ts
* import { LoroDoc } from "loro-crdt";
*
* const doc = new LoroDoc();
* const list = doc.getList("list");
* const containerId = list.id;
* ```
*/
export type ContainerID =
  | `cid:root-${string}:${ContainerType}`
  | `cid:${number}@${PeerID}:${ContainerType}`;

/**
 * The unique id of each tree node.
 */
export type TreeID = `${number}@${PeerID}`;

interface LoroDoc {
    /**
     *
     *  Get the container corresponding to the container id
     *
     *
     *  @example
     *  ```ts
     *  import { LoroDoc } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  let text = doc.getText("text");
     *  const textId = text.id;
     *  text = doc.getContainerById(textId);
     *  ```
     */
    getContainerById(id: ContainerID): Container | undefined;

    /**
     * Subscribe to updates from local edits.
     *
     * This method allows you to listen for local changes made to the document.
     * It's useful for syncing changes with other instances or saving updates.
     *
     * @param f - A callback function that receives a Uint8Array containing the update data.
     * @returns A function to unsubscribe from the updates.
     *
     * @example
     * ```ts
     * const loro = new Loro();
     * const text = loro.getText("text");
     *
     * const unsubscribe = loro.subscribeLocalUpdates((update) => {
     *   console.log("Local update received:", update);
     *   // You can send this update to other Loro instances
     * });
     *
     * text.insert(0, "Hello");
     * loro.commit();
     *
     * // Later, when you want to stop listening:
     * unsubscribe();
     * ```
     *
     * @example
     * ```ts
     * const loro1 = new Loro();
     * const loro2 = new Loro();
     *
     * // Set up two-way sync
     * loro1.subscribeLocalUpdates((updates) => {
     *   loro2.import(updates);
     * });
     *
     * loro2.subscribeLocalUpdates((updates) => {
     *   loro1.import(updates);
     * });
     *
     * // Now changes in loro1 will be reflected in loro2 and vice versa
     * ```
     */
    subscribeLocalUpdates(f: (bytes: Uint8Array) => void): () => void

    /**
     * Subscribe to the first commit from a peer. Operations performed on the `LoroDoc` within this callback
     * will be merged into the current commit.
     *
     * This is useful for managing the relationship between `PeerID` and user information.
     * For example, you could store user names in a `LoroMap` using `PeerID` as the key and the `UserID` as the value.
     *
     * @param f - A callback function that receives a peer id.
     *
     * @example
     * ```ts
     * const doc = new LoroDoc();
     * doc.setPeerId(0);
     * const p = [];
     * doc.subscribeFirstCommitFromPeer((peer) => {
     *   p.push(peer);
     *   doc.getMap("map").set(e.peer, "user-" + e.peer);
     * });
     * doc.getList("list").insert(0, 100);
     * doc.commit();
     * doc.getList("list").insert(0, 200);
     * doc.commit();
     * doc.setPeerId(1);
     * doc.getList("list").insert(0, 300);
     * doc.commit();
     * expect(p).toEqual(["0", "1"]);
     * expect(doc.getMap("map").get("0")).toBe("user-0");
     * ```
     **/
    subscribeFirstCommitFromPeer(f: (e: { peer: PeerID }) => void): () => void

    /**
     * Subscribe to the pre-commit event.
     *
     * The callback will be called when the changes are committed but not yet applied to the OpLog.
     * You can modify the commit message and timestamp in the callback by `ChangeModifier`.
     *
     * @example
     * ```ts
     * const doc = new LoroDoc();
     * doc.subscribePreCommit((e) => {
     *   e.modifier.setMessage("test").setTimestamp(Date.now());
     * });
     * doc.getList("list").insert(0, 100);
     * doc.commit();
     * expect(doc.getChangeAt({ peer: "0", counter: 0 }).message).toBe("test");
     * ```
     *
     * ### Advanced Example: Creating a Merkle DAG
     *
     * By combining `doc.subscribePreCommit` with `doc.exportJsonInIdSpan`, you can implement advanced features like representing Loro's editing history as a Merkle DAG:
     *
     * ```ts
     * const doc = new LoroDoc();
     * doc.setPeerId(0);
     * doc.subscribePreCommit((e) => {
     *   const changes = doc.exportJsonInIdSpan(e.changeMeta)
     *   expect(changes).toHaveLength(1);
     *   const hash = crypto.createHash('sha256');
     *   const change = {
     *     ...changes[0],
     *     deps: changes[0].deps.map(d => {
     *       const depChange = doc.getChangeAt(idStrToId(d))
     *       return depChange.message;
     *     })
     *   }
     *   console.log(change); // The output is shown below
     *   hash.update(JSON.stringify(change));
     *   const sha256Hash = hash.digest('hex');
     *   e.modifier.setMessage(sha256Hash);
     * });
     *
     * doc.getList("list").insert(0, 100);
     * doc.commit();
     * // Change 0
     * // {
     * //   id: '0@0',
     * //   timestamp: 0,
     * //   deps: [],
     * //   lamport: 0,
     * //   msg: undefined,
     * //   ops: [
     * //     {
     * //       container: 'cid:root-list:List',
     * //       content: { type: 'insert', pos: 0, value: [100] },
     * //       counter: 0
     * //     }
     * //   ]
     * // }
     *
     *
     * doc.getList("list").insert(0, 200);
     * doc.commit();
     * // Change 1
     * // {
     * //   id: '1@0',
     * //   timestamp: 0,
     * //   deps: [
     * //     '2af99cf93869173984bcf6b1ce5412610b0413d027a5511a8f720a02a4432853'
     * //   ],
     * //   lamport: 1,
     * //   msg: undefined,
     * //   ops: [
     * //     {
     * //       container: 'cid:root-list:List',
     * //       content: { type: 'insert', pos: 0, value: [200] },
     * //       counter: 1
     * //     }
     * //   ]
     * // }
     *
     * expect(doc.getChangeAt({ peer: "0", counter: 0 }).message).toBe("2af99cf93869173984bcf6b1ce5412610b0413d027a5511a8f720a02a4432853");
     * expect(doc.getChangeAt({ peer: "0", counter: 1 }).message).toBe("aedbb442c554ecf59090e0e8339df1d8febf647f25cc37c67be0c6e27071d37f");
     * ```
     *
     * @param f - A callback function that receives a pre commit event.
     *
     **/
    subscribePreCommit(f: (e: { changeMeta: Change, origin: string, modifier: ChangeModifier }) => void): () => void

    /**
     * Convert the document to a JSON value with a custom replacer function.
     *
     * This method works similarly to `JSON.stringify`'s replacer parameter.
     * The replacer function is called for each value in the document and can transform
     * how values are serialized to JSON.
     *
     * @param replacer - A function that takes a key and value, and returns how that value
     *                  should be serialized. Similar to JSON.stringify's replacer.
     *                  If return undefined, the value will be skipped.
     * @returns The JSON representation of the document after applying the replacer function.
     *
     * @example
     * ```ts
     * const doc = new LoroDoc();
     * const text = doc.getText("text");
     * text.insert(0, "Hello");
     * text.mark({ start: 0, end: 2 }, "bold", true);
     *
     * // Use delta to represent text
     * const json = doc.toJsonWithReplacer((key, value) => {
     *   if (value instanceof LoroText) {
     *     return value.toDelta();
     *   }
     *
     *   return value;
     * });
     * ```
     */
    toJsonWithReplacer(replacer: (key: string | index, value: Value | Container) => Value | Container | undefined): Value;

    /**
     * Calculate the differences between two frontiers
     *
     * The entries in the returned object are sorted by causal order: the creation of a child container will be
     * presented before its use.
     *
     * @param from - The source frontier to diff from. A frontier represents a consistent version of the document.
     * @param to - The target frontier to diff to. A frontier represents a consistent version of the document.
     * @param for_json - Controls the diff format:
     *                   - If true, returns JsonDiff format suitable for JSON serialization
     *                   - If false, returns Diff format that shares the same type as LoroEvent
     *                   - The default value is `true`
     */
    diff(from: OpId[], to: OpId[], for_json: false): [ContainerID, Diff][];
    diff(from: OpId[], to: OpId[], for_json: true): [ContainerID, JsonDiff][];
    diff(from: OpId[], to: OpId[], for_json: undefined): [ContainerID, JsonDiff][];
    diff(from: OpId[], to: OpId[], for_json?: boolean): [ContainerID, JsonDiff|Diff][];
}

/**
 * Represents a `Delta` type which is a union of different operations that can be performed.
 *
 * @typeparam T - The data type for the `insert` operation.
 *
 * The `Delta` type can be one of three distinct shapes:
 *
 * 1. Insert Operation:
 *    - `insert`: The item to be inserted, of type T.
 *    - `attributes`: (Optional) A dictionary of attributes, describing styles in richtext
 *
 * 2. Delete Operation:
 *    - `delete`: The number of elements to delete.
 *
 * 3. Retain Operation:
 *    - `retain`: The number of elements to retain.
 *    - `attributes`: (Optional) A dictionary of attributes, describing styles in richtext
 */
export type Delta<T> =
  | {
    insert: T;
    attributes?: { [key in string]: Value };
    retain?: undefined;
    delete?: undefined;
  }
  | {
    delete: number;
    attributes?: undefined;
    retain?: undefined;
    insert?: undefined;
  }
  | {
    retain: number;
    attributes?: { [key in string]: Value };
    delete?: undefined;
    insert?: undefined;
  };

/**
 * The unique id of each operation.
 */
export type OpId = { peer: PeerID, counter: number };

/**
 * Change is a group of continuous operations
 */
export interface Change {
    peer: PeerID,
    counter: number,
    lamport: number,
    length: number,
    /**
     * The timestamp in seconds.
     *
     * [Unix time](https://en.wikipedia.org/wiki/Unix_time)
     * It is the number of seconds that have elapsed since 00:00:00 UTC on 1 January 1970.
     */
    timestamp: number,
    deps: OpId[],
    message: string | undefined,
}


/**
 * Data types supported by loro
 */
export type Value =
  | ContainerID
  | string
  | number
  | boolean
  | null
  | { [key: string]: Value }
  | Uint8Array
  | Value[]
  | undefined;

export type IdSpan = {
    peer: PeerID,
    counter: number,
    length: number,
}

export type VersionVectorDiff = {
    /**
     * The spans that the `from` side needs to retreat to reach the `to` side
     *
     * These spans are included in the `from`, but not in the `to`
     */
    retreat: IdSpan[],
    /**
     * The spans that the `from` side needs to forward to reach the `to` side
     *
     * These spans are included in the `to`, but not in the `from`
     */
    forward: IdSpan[],
}

export type UndoConfig = {
    mergeInterval?: number,
    maxUndoSteps?: number,
    excludeOriginPrefixes?: string[],
    onPush?: (isUndo: boolean, counterRange: { start: number, end: number }, event?: LoroEventBatch) => { value: Value, cursors: Cursor[] },
    onPop?: (isUndo: boolean, value: { value: Value, cursors: Cursor[] }, counterRange: { start: number, end: number }) => void
};
export type Container = LoroList | LoroMap | LoroText | LoroTree | LoroMovableList | LoroCounter;

export interface ImportBlobMetadata {
    /**
     * The version vector of the start of the import.
     *
     * Import blob includes all the ops from `partial_start_vv` to `partial_end_vv`.
     * However, it does not constitute a complete version vector, as it only contains counters
     * from peers included within the import blob.
     */
    partialStartVersionVector: VersionVector;
    /**
     * The version vector of the end of the import.
     *
     * Import blob includes all the ops from `partial_start_vv` to `partial_end_vv`.
     * However, it does not constitute a complete version vector, as it only contains counters
     * from peers included within the import blob.
     */
    partialEndVersionVector: VersionVector;

    startFrontiers: OpId[],
    startTimestamp: number;
    endTimestamp: number;
    mode: "outdated-snapshot" | "outdated-update" | "snapshot" | "shallow-snapshot" | "update";
    changeNum: number;
}

interface LoroText {
    /**
     * Convert a position between coordinate systems.
     */
    convertPos(index: number, from: TextPosType, to: TextPosType): number | undefined;

    /**
     * Get the cursor position at the given pos.
     *
     * When expressing the position of a cursor, using "index" can be unstable
     * because the cursor's position may change due to other deletions and insertions,
     * requiring updates with each edit. To stably represent a position or range within
     * a list structure, we can utilize the ID of each item/character on List CRDT or
     * Text CRDT for expression.
     *
     * Loro optimizes State metadata by not storing the IDs of deleted elements. This
     * approach complicates tracking cursors since they rely on these IDs. The solution
     * recalculates position by replaying relevant history to update cursors
     * accurately. To minimize the performance impact of history replay, the system
     * updates cursor info to reference only the IDs of currently present elements,
     * thereby reducing the need for replay.
     *
     * @example
     * ```ts
     *
     * const doc = new LoroDoc();
     * const text = doc.getText("text");
     * text.insert(0, "123");
     * const pos0 = text.getCursor(0, 0);
     * {
     *   const ans = doc.getCursorPos(pos0!);
     *   expect(ans.offset).toBe(0);
     * }
     * text.insert(0, "1");
     * {
     *   const ans = doc.getCursorPos(pos0!);
     *   expect(ans.offset).toBe(1);
     * }
     * ```
     */
    getCursor(pos: number, side?: Side): Cursor | undefined;
}

interface LoroList {
    /**
     * Get the cursor position at the given pos.
     *
     * When expressing the position of a cursor, using "index" can be unstable
     * because the cursor's position may change due to other deletions and insertions,
     * requiring updates with each edit. To stably represent a position or range within
     * a list structure, we can utilize the ID of each item/character on List CRDT or
     * Text CRDT for expression.
     *
     * Loro optimizes State metadata by not storing the IDs of deleted elements. This
     * approach complicates tracking cursors since they rely on these IDs. The solution
     * recalculates position by replaying relevant history to update cursors
     * accurately. To minimize the performance impact of history replay, the system
     * updates cursor info to reference only the IDs of currently present elements,
     * thereby reducing the need for replay.
     *
     * @example
     * ```ts
     *
     * const doc = new LoroDoc();
     * const text = doc.getList("list");
     * text.insert(0, "1");
     * const pos0 = text.getCursor(0, 0);
     * {
     *   const ans = doc.getCursorPos(pos0!);
     *   expect(ans.offset).toBe(0);
     * }
     * text.insert(0, "1");
     * {
     *   const ans = doc.getCursorPos(pos0!);
     *   expect(ans.offset).toBe(1);
     * }
     * ```
     */
    getCursor(pos: number, side?: Side): Cursor | undefined;
}

export type TreeNodeShallowValue = {
    id: TreeID,
    parent: TreeID | undefined,
    index: number,
    fractionalIndex: string,
    meta: ContainerID,
    children: TreeNodeShallowValue[],
}

export type TreeNodeValue = {
    id: TreeID,
    parent: TreeID | undefined,
    index: number,
    fractionalIndex: string,
    meta: LoroMap,
    children: TreeNodeValue[],
}

export type TreeNodeJSON<T> = Omit<TreeNodeValue, 'meta' | 'children'> & {
    meta: T,
    children: TreeNodeJSON<T>[],
}

interface LoroMovableList {
    /**
     * Get the cursor position at the given pos.
     *
     * When expressing the position of a cursor, using "index" can be unstable
     * because the cursor's position may change due to other deletions and insertions,
     * requiring updates with each edit. To stably represent a position or range within
     * a list structure, we can utilize the ID of each item/character on List CRDT or
     * Text CRDT for expression.
     *
     * Loro optimizes State metadata by not storing the IDs of deleted elements. This
     * approach complicates tracking cursors since they rely on these IDs. The solution
     * recalculates position by replaying relevant history to update cursors
     * accurately. To minimize the performance impact of history replay, the system
     * updates cursor info to reference only the IDs of currently present elements,
     * thereby reducing the need for replay.
     *
     * @example
     * ```ts
     *
     * const doc = new LoroDoc();
     * const text = doc.getMovableList("text");
     * text.insert(0, "1");
     * const pos0 = text.getCursor(0, 0);
     * {
     *   const ans = doc.getCursorPos(pos0!);
     *   expect(ans.offset).toBe(0);
     * }
     * text.insert(0, "1");
     * {
     *   const ans = doc.getCursorPos(pos0!);
     *   expect(ans.offset).toBe(1);
     * }
     * ```
     */
    getCursor(pos: number, side?: Side): Cursor | undefined;
}

export type Side = -1 | 0 | 1;
export type JsonOpID = `${number}@${PeerID}`;
export type JsonContainerID =  `🦜:${ContainerID}` ;
export type JsonValue  =
  | JsonContainerID
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | Uint8Array
  | JsonValue[];

export type JsonSchema = {
  schema_version: number;
  start_version: Map<string, number>,
  peers: PeerID[],
  changes: JsonChange[]
};

export type JsonChange = {
  id: JsonOpID
  /**
   * The timestamp in seconds.
   *
   * [Unix time](https://en.wikipedia.org/wiki/Unix_time)
   * It is the number of seconds that have elapsed since 00:00:00 UTC on 1 January 1970.
   */
  timestamp: number,
  deps: JsonOpID[],
  lamport: number,
  msg: string | null,
  ops: JsonOp[]
}

export interface TextUpdateOptions {
    timeoutMs?: number,
    useRefinedDiff?: boolean,
}

export type ExportMode = {
    mode: "update",
    from?: VersionVector,
} | {
    mode: "snapshot",
} | {
    mode: "shallow-snapshot",
    frontiers: Frontiers,
} | {
    mode: "updates-in-range",
    spans: {
        id: OpId,
        len: number,
    }[],
};

export type JsonOp = {
  container: ContainerID,
  counter: number,
  content: ListOp | TextOp | MapOp | TreeOp | MovableListOp | UnknownOp
}

export type ListOp = {
  type: "insert",
  pos: number,
  value: JsonValue
} | {
  type: "delete",
  pos: number,
  len: number,
  start_id: JsonOpID,
};

export type MovableListOp = {
  type: "insert",
  pos: number,
  value: JsonValue
} | {
  type: "delete",
  pos: number,
  len: number,
  start_id: JsonOpID,
}| {
  type: "move",
  from: number,
  to: number,
  elem_id: JsonOpID,
}|{
  type: "set",
  elem_id: JsonOpID,
  value: JsonValue
}

export type TextOp = {
  type: "insert",
  pos: number,
  text: string
} | {
  type: "delete",
  pos: number,
  len: number,
  start_id: JsonOpID,
} | {
  type: "mark",
  start: number,
  end: number,
  style_key: string,
  style_value: JsonValue,
  info: number
}|{
  type: "mark_end"
};

export type MapOp = {
  type: "insert",
  key: string,
  value: JsonValue
} | {
  type: "delete",
  key: string,
};

export type TreeOp = {
  type: "create",
  target: TreeID,
  parent: TreeID | undefined,
  fractional_index: string
}|{
  type: "move",
  target: TreeID,
  parent: TreeID | undefined,
  fractional_index: string
}|{
  type: "delete",
  target: TreeID
};

export type UnknownOp = {
  type: "unknown"
  prop: number,
  value_type: "unknown",
  value: {
    kind: number,
    data: Uint8Array
  }
};

export type CounterSpan = { start: number, end: number };

export type ImportStatus = {
  success: Map<PeerID, CounterSpan>,
  pending: Map<PeerID, CounterSpan> | null
}

export type Frontiers = OpId[];

/**
 * Represents a path to identify the exact location of an event's target.
 * The path is composed of numbers (e.g., indices of a list container) strings
 * (e.g., keys of a map container) and TreeID (the node of a tree container),
 * indicating the absolute position of the event's source within a loro document.
 */
export type Path = (number | string | TreeID)[];

/**
 * A batch of events that created by a single `import`/`transaction`/`checkout`.
 *
 * @prop by - How the event is triggered.
 * @prop origin - (Optional) Provides information about the origin of the event.
 * @prop diff - Contains the differential information related to the event.
 * @prop target - Identifies the container ID of the event's target.
 * @prop path - Specifies the absolute path of the event's emitter, which can be an index of a list container or a key of a map container.
 */
export interface LoroEventBatch {
    /**
     * How the event is triggered.
     *
     * - `local`: The event is triggered by a local transaction.
     * - `import`: The event is triggered by an import operation.
     * - `checkout`: The event is triggered by a checkout operation.
     */
    by: "local" | "import" | "checkout";
    origin?: string;
    /**
     * The container ID of the current event receiver.
     * It's undefined if the subscriber is on the root document.
     */
    currentTarget?: ContainerID;
    events: LoroEvent[];
    from: Frontiers;
    to: Frontiers;
}

/**
 * The concrete event of Loro.
 */
export interface LoroEvent {
    /**
     * The container ID of the event's target.
     */
    target: ContainerID;
    diff: Diff;
    /**
     * The absolute path of the event's emitter, which can be an index of a list container or a key of a map container.
     */
    path: Path;
}

export type ListDiff = {
    type: "list";
    diff: Delta<(Value | Container)[]>[];
};

export type ListJsonDiff = {
    type: "list";
    diff: Delta<(Value | JsonContainerID )[]>[];
};

export type TextDiff = {
    type: "text";
    diff: Delta<string>[];
};

export type MapDiff = {
    type: "map";
    updated: Record<string, Value | Container | undefined>;
};

export type MapJsonDiff = {
    type: "map";
    updated: Record<string, Value | JsonContainerID | undefined>;
};

export type TreeDiffItem =
    | {
        target: TreeID;
        action: "create";
        parent: TreeID | undefined;
        index: number;
        fractionalIndex: string;
    }
    | {
        target: TreeID;
        action: "delete";
        oldParent: TreeID | undefined;
        oldIndex: number;
    }
    | {
        target: TreeID;
        action: "move";
        parent: TreeID | undefined;
        index: number;
        fractionalIndex: string;
        oldParent: TreeID | undefined;
        oldIndex: number;
    };

export type TreeDiff = {
    type: "tree";
    diff: TreeDiffItem[];
};

export type CounterDiff = {
    type: "counter";
    increment: number;
};

export type Diff = ListDiff | TextDiff | MapDiff | TreeDiff | CounterDiff;
export type JsonDiff = ListJsonDiff | TextDiff | MapJsonDiff | CounterDiff | TreeDiff;
export type Subscription = () => void;
type NonNullableType<T> = Exclude<T, null | undefined>;
export type AwarenessListener = (
    arg: { updated: PeerID[]; added: PeerID[]; removed: PeerID[] },
    origin: "local" | "timeout" | "remote" | string,
) => void;

interface Listener {
    (event: LoroEventBatch): void;
}

interface LoroDoc {
    subscribe(listener: Listener): Subscription;
    /**
     * Subscribe to changes that may affect a JSONPath query.
     * Callback may fire false positives and carries no query result.
     * You can debounce/throttle the callback before running `JSONPath(...)` to optimize heavy reads.
     */
    subscribeJsonpath(path: string, callback: () => void): Subscription;
}

interface UndoManager {
    /**
     * Set the callback function that is called when an undo/redo step is pushed.
     * The function can return a meta data value that will be attached to the given stack item.
     *
     * @param listener - The callback function.
     */
    setOnPush(listener?: UndoConfig["onPush"]): void;
    /**
     * Set the callback function that is called when an undo/redo step is popped.
     * The function will have a meta data value that was attached to the given stack item when `onPush` was called.
     *
     * @param listener - The callback function.
     */
    setOnPop(listener?: UndoConfig["onPop"]): void;

    /**
     * Starts a new grouping of undo operations.
     * All changes/commits made after this call will be grouped/merged together.
     * to end the group, call `groupEnd`.
     *
     * If a remote import is received within the group, its possible that the undo item will be
     * split and the group will be automatically ended.
     *
     * Calling `groupStart` within an active group will throw but have no effect.
     *
     */
    groupStart(): void;

    /**
     * Ends the current grouping of undo operations.
     */
    groupEnd(): void;

    /**
     * Clear only the redo stack, preserving the undo stack.
     *
     * This is useful when coordinating undo/redo across multiple participants
     * (e.g., multiple editors) where a new edit in one participant should
     * invalidate redo in all other participants.
     */
    clearRedo(): void;

    /**
     * Clear only the undo stack, preserving the redo stack.
     */
    clearUndo(): void;
}
interface LoroDoc<T extends Record<string, Container> = Record<string, Container>> {
    /**
     * Subscribe to changes that may affect a JSONPath query.
     * Callback may fire false positives and carries no query result.
     * You can debounce/throttle the callback before running `JSONPath(...)` to optimize heavy reads.
     */
    subscribeJsonpath(path: string, callback: () => void): Subscription;
    /**
     * Get a LoroMap by container id
     *
     * The object returned is a new js object each time because it need to cross
     * the WASM boundary.
     *
     * @example
     * ```ts
     * import { LoroDoc } from "loro-crdt";
     *
     * const doc = new LoroDoc();
     * const map = doc.getMap("map");
     * ```
     */
    getMap<Key extends keyof T | ContainerID>(name: Key): T[Key] extends LoroMap ? T[Key] : LoroMap;
    /**
     * Get a LoroList by container id
     *
     * The object returned is a new js object each time because it need to cross
     * the WASM boundary.
     *
     * @example
     * ```ts
     * import { LoroDoc } from "loro-crdt";
     *
     * const doc = new LoroDoc();
     * const list = doc.getList("list");
     * ```
     */
    getList<Key extends keyof T | ContainerID>(name: Key): T[Key] extends LoroList ? T[Key] : LoroList;
    /**
     * Get a LoroMovableList by container id
     *
     * The object returned is a new js object each time because it need to cross
     * the WASM boundary.
     *
     * @example
     * ```ts
     * import { LoroDoc } from "loro-crdt";
     *
     * const doc = new LoroDoc();
     * const list = doc.getMovableList("list");
     * ```
     */
    getMovableList<Key extends keyof T | ContainerID>(name: Key): T[Key] extends LoroMovableList ? T[Key] : LoroMovableList;
    /**
     * Get a LoroTree by container id
     *
     *  The object returned is a new js object each time because it need to cross
     *  the WASM boundary.
     *
     *  @example
     *  ```ts
     *  import { LoroDoc } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const tree = doc.getTree("tree");
     *  ```
     */
    getTree<Key extends keyof T | ContainerID>(name: Key): T[Key] extends LoroTree ? T[Key] : LoroTree;
    getText(key: string | ContainerID): LoroText;
    /**
     * Export the updates in the given range.
     *
     * @param start - The start version vector.
     * @param end - The end version vector.
     * @param withPeerCompression - Whether to compress the peer IDs in the updates. Defaults to true. If you want to process the operations in application code, set this to false.
     * @returns The updates in the given range.
     */
    exportJsonUpdates(start?: VersionVector, end?: VersionVector, withPeerCompression?: boolean): JsonSchema;
    /**
     * Exports changes within the specified ID span to JSON schema format.
     *
     * The JSON schema format produced by this method is identical to the one generated by `export_json_updates`.
     * It ensures deterministic output, making it ideal for hash calculations and integrity checks.
     *
     * This method can also export pending changes from the uncommitted transaction that have not yet been applied to the OpLog.
     *
     * This method will implicitly commit pending local operations (like `export(...)`) so callers can
     * observe the latest local edits. When called inside `subscribePreCommit(...)`, it will NOT trigger
     * an additional implicit commit.
     *
     * @param idSpan - The id span to export.
     * @returns The changes in the given id span.
     */
    exportJsonInIdSpan(idSpan: IdSpan): JsonChange[];
}
interface LoroList<T = unknown> {
    new(): LoroList<T>;
    /**
     *  Get elements of the list. If the value is a child container, the corresponding
     *  `Container` will be returned.
     *
     *  @example
     *  ```ts
     *  import { LoroDoc, LoroText } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const list = doc.getList("list");
     *  list.insert(0, 100);
     *  list.insert(1, "foo");
     *  list.insert(2, true);
     *  list.insertContainer(3, new LoroText());
     *  console.log(list.value);  // [100, "foo", true, LoroText];
     *  ```
     */
    toArray(): T[];
    /**
     * Insert a container at the index.
     *
     *  @example
     *  ```ts
     *  import { LoroDoc, LoroText } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const list = doc.getList("list");
     *  list.insert(0, 100);
     *  const text = list.insertContainer(1, new LoroText());
     *  text.insert(0, "Hello");
     *  console.log(list.toJSON());  // [100, "Hello"];
     *  ```
     */
    insertContainer<C extends Container>(pos: number, child: C): T extends C ? T : C;
    /**
     * Push a container to the end of the list.
     */
    pushContainer<C extends Container>(child: C): T extends C ? T : C;
    /**
     * Get the value at the index. If the value is a container, the corresponding handler will be returned.
     *
     *  @example
     *  ```ts
     *  import { LoroDoc } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const list = doc.getList("list");
     *  list.insert(0, 100);
     *  console.log(list.get(0));  // 100
     *  console.log(list.get(1));  // undefined
     *  ```
     */
    get(index: number): T;
    /**
     *  Insert a value at index.
     *
     *  @example
     *  ```ts
     *  import { LoroDoc } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const list = doc.getList("list");
     *  list.insert(0, 100);
     *  list.insert(1, "foo");
     *  list.insert(2, true);
     *  console.log(list.value);  // [100, "foo", true];
     *  ```
     */
    insert<V extends T>(pos: number, value: Exclude<V, Container>): void;
    delete(pos: number, len: number): void;
    push<V extends T>(value: Exclude<V, Container>): void;
    subscribe(listener: Listener): Subscription;
    getAttached(): undefined | LoroList<T>;
}
interface LoroMovableList<T = unknown> {
    new(): LoroMovableList<T>;
    /**
     *  Get elements of the list. If the value is a child container, the corresponding
     *  `Container` will be returned.
     *
     *  @example
     *  ```ts
     *  import { LoroDoc, LoroText } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const list = doc.getMovableList("list");
     *  list.insert(0, 100);
     *  list.insert(1, "foo");
     *  list.insert(2, true);
     *  list.insertContainer(3, new LoroText());
     *  console.log(list.value);  // [100, "foo", true, LoroText];
     *  ```
     */
    toArray(): T[];
    /**
     * Insert a container at the index.
     *
     *  @example
     *  ```ts
     *  import { LoroDoc, LoroText } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const list = doc.getMovableList("list");
     *  list.insert(0, 100);
     *  const text = list.insertContainer(1, new LoroText());
     *  text.insert(0, "Hello");
     *  console.log(list.toJSON());  // [100, "Hello"];
     *  ```
     */
    insertContainer<C extends Container>(pos: number, child: C): T extends C ? T : C;
    /**
     * Push a container to the end of the list.
     */
    pushContainer<C extends Container>(child: C): T extends C ? T : C;
    /**
     * Get the value at the index. If the value is a container, the corresponding handler will be returned.
     *
     *  @example
     *  ```ts
     *  import { LoroDoc } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const list = doc.getMovableList("list");
     *  list.insert(0, 100);
     *  console.log(list.get(0));  // 100
     *  console.log(list.get(1));  // undefined
     *  ```
     */
    get(index: number): T;
    /**
     *  Insert a value at index.
     *
     *  @example
     *  ```ts
     *  import { LoroDoc } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const list = doc.getMovableList("list");
     *  list.insert(0, 100);
     *  list.insert(1, "foo");
     *  list.insert(2, true);
     *  console.log(list.value);  // [100, "foo", true];
     *  ```
     */
    insert<V extends T>(pos: number, value: Exclude<V, Container>): void;
    delete(pos: number, len: number): void;
    push<V extends T>(value: Exclude<V, Container>): void;
    subscribe(listener: Listener): Subscription;
    getAttached(): undefined | LoroMovableList<T>;
    /**
     *  Set the value at the given position.
     *
     *  It's different from `delete` + `insert` that it will replace the value at the position.
     *
     *  For example, if you have a list `[1, 2, 3]`, and you call `set(1, 100)`, the list will be `[1, 100, 3]`.
     *  If concurrently someone call `set(1, 200)`, the list will be `[1, 200, 3]` or `[1, 100, 3]`.
     *
     *  But if you use `delete` + `insert` to simulate the set operation, they may create redundant operations
     *  and the final result will be `[1, 100, 200, 3]` or `[1, 200, 100, 3]`.
     *
     *  @example
     *  ```ts
     *  import { LoroDoc } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const list = doc.getMovableList("list");
     *  list.insert(0, 100);
     *  list.insert(1, "foo");
     *  list.insert(2, true);
     *  list.set(1, "bar");
     *  console.log(list.value);  // [100, "bar", true];
     *  ```
     */
    set<V extends T>(pos: number, value: Exclude<V, Container>): void;
    /**
     * Set a container at the index.
     *
     *  @example
     *  ```ts
     *  import { LoroDoc, LoroText } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const list = doc.getMovableList("list");
     *  list.insert(0, 100);
     *  const text = list.setContainer(0, new LoroText());
     *  text.insert(0, "Hello");
     *  console.log(list.toJSON());  // ["Hello"];
     *  ```
     */
    setContainer<C extends Container>(pos: number, child: C): T extends C ? T : C;
}

interface LoroMap<T extends Record<string, unknown> = Record<string, unknown>> {
    new(): LoroMap<T>;
    /**
     *  Get the value of the key. If the value is a child container, the corresponding
     *  `Container` will be returned.
     *
     *  The object returned is a new js object each time because it need to cross
     *
     *  @example
     *  ```ts
     *  import { LoroDoc } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const map = doc.getMap("map");
     *  map.set("foo", "bar");
     *  const bar = map.get("foo");
     *  ```
     */
    getOrCreateContainer<C extends Container>(key: string, child: C): C;
    /**
     * Set the key with a container.
     *
     *  @example
     *  ```ts
     *  import { LoroDoc, LoroText, LoroList } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const map = doc.getMap("map");
     *  map.set("foo", "bar");
     *  const text = map.setContainer("text", new LoroText());
     *  const list = map.setContainer("list", new LoroList());
     *  ```
     */
    setContainer<C extends Container, Key extends keyof T>(key: Key, child: C): NonNullableType<T[Key]> extends C ? NonNullableType<T[Key]> : C;
    /**
     *  Get the value of the key. If the value is a child container, the corresponding
     *  `Container` will be returned.
     *
     *  The object/value returned is a new js object/value each time because it need to cross
     *  the WASM boundary.
     *
     *  @example
     *  ```ts
     *  import { LoroDoc } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const map = doc.getMap("map");
     *  map.set("foo", "bar");
     *  const bar = map.get("foo");
     *  ```
     */
    get<Key extends keyof T>(key: Key): T[Key];
    /**
     *  Set the key with the value.
     *
     *  If the key already exists, its value will be updated. If the key doesn't exist,
     *  a new key-value pair will be created.
     *
     *  > **Note**: When calling `map.set(key, value)` on a LoroMap, if `map.get(key)` already returns `value`,
     *  > the operation will be a no-op (no operation recorded) to avoid unnecessary updates.
     *
     *  @example
     *  ```ts
     *  import { LoroDoc } from "loro-crdt";
     *
     *  const doc = new LoroDoc();
     *  const map = doc.getMap("map");
     *  map.set("foo", "bar");
     *  map.set("foo", "baz");
     *  ```
     */
    set<Key extends keyof T, V extends T[Key]>(key: Key, value: Exclude<V, Container>): void;
    delete(key: string): void;
    subscribe(listener: Listener): Subscription;
}
interface LoroText {
    new(): LoroText;
    insert(pos: number, text: string): void;
    delete(pos: number, len: number): void;
    subscribe(listener: Listener): Subscription;
    /**
     * Convert a position between coordinate systems.
     */
    convertPos(index: number, from: TextPosType, to: TextPosType): number | undefined;
    /**
     * Update the current text to the target text.
     *
     * It will calculate the minimal difference and apply it to the current text.
     * It uses Myers' diff algorithm to compute the optimal difference.
     *
     * This could take a long time for large texts (e.g. > 50_000 characters).
     * In that case, you should use `updateByLine` instead.
     *
     * @example
     * ```ts
     * import { LoroDoc } from "loro-crdt";
     *
     * const doc = new LoroDoc();
     * const text = doc.getText("text");
     * text.insert(0, "Hello");
     * text.update("Hello World");
     * console.log(text.toString()); // "Hello World"
     * ```
     */
    update(text: string, options?: TextUpdateOptions): void;
    /**
     * Update the current text based on the provided text.
     * This update calculation is line-based, which will be more efficient but less precise.
     */
    updateByLine(text: string, options?: TextUpdateOptions): void;
}
interface LoroTree<T extends Record<string, unknown> = Record<string, unknown>> {
    new(): LoroTree<T>;
    /**
     * Create a new tree node as the child of parent and return a `LoroTreeNode` instance.
     * If the parent is undefined, the tree node will be a root node.
     *
     * If the index is not provided, the new node will be appended to the end.
     *
     * @example
     * ```ts
     * import { LoroDoc } from "loro-crdt";
     *
     * const doc = new LoroDoc();
     * const tree = doc.getTree("tree");
     * const root = tree.createNode();
     * const node = tree.createNode(undefined, 0);
     *
     * //  undefined
     * //    /   \
     * // node  root
     * ```
     */
    createNode(parent?: TreeID, index?: number): LoroTreeNode<T>;
    move(target: TreeID, parent?: TreeID, index?: number): void;
    delete(target: TreeID): void;
    has(target: TreeID): boolean;
    /**
     * Get LoroTreeNode by the TreeID.
     */
    getNodeByID(target: TreeID): LoroTreeNode<T> | undefined;
    subscribe(listener: Listener): Subscription;
    toArray(): TreeNodeValue[];
    getNodes(options?: { withDeleted?: boolean } ): LoroTreeNode<T>[];
}
interface LoroTreeNode<T extends Record<string, unknown> = Record<string, unknown>> {
    /**
     * Get the associated metadata map container of a tree node.
     */
    readonly data: LoroMap<T>;
    /**
     * Create a new node as the child of the current node and
     * return an instance of `LoroTreeNode`.
     *
     * If the index is not provided, the new node will be appended to the end.
     *
     * @example
     * ```typescript
     * import { LoroDoc } from "loro-crdt";
     *
     * let doc = new LoroDoc();
     * let tree = doc.getTree("tree");
     * let root = tree.createNode();
     * let node = root.createNode();
     * let node2 = root.createNode(0);
     * //    root
     * //    /  \
     * // node2 node
     * ```
     */
    createNode(index?: number): LoroTreeNode<T>;
    /**
     * Move this tree node to be a child of the parent.
     * If the parent is undefined, this node will be a root node.
     *
     * If the index is not provided, the node will be appended to the end.
     *
     * It's not allowed that the target is an ancestor of the parent.
     *
     * @example
     * ```ts
     * const doc = new LoroDoc();
     * const tree = doc.getTree("tree");
     * const root = tree.createNode();
     * const node = root.createNode();
     * const node2 = node.createNode();
     * node2.move(undefined, 0);
     * // node2   root
     * //          |
     * //         node
     *
     * ```
     */
    move(parent?: LoroTreeNode<T>, index?: number): void;
    /**
     * Get the parent node of this node.
     *
     * - The parent of the root node is `undefined`.
     * - The object returned is a new js object each time because it need to cross
     *   the WASM boundary.
     */
    parent(): LoroTreeNode<T> | undefined;
    /**
     * Get the children of this node.
     *
     * The objects returned are new js objects each time because they need to cross
     * the WASM boundary.
     */
    children(): Array<LoroTreeNode<T>> | undefined;
    toJSON(): TreeNodeJSON<T>;
}
interface AwarenessWasm<T extends Value = Value> {
    getState(peer: PeerID): T | undefined;
    getTimestamp(peer: PeerID): number | undefined;
    getAllStates(): Record<PeerID, T>;
    setLocalState(value: T): void;
    removeOutdated(): PeerID[];
}

type EphemeralListener = (event: EphemeralStoreEvent) => void;
type EphemeralLocalListener = (bytes: Uint8Array) => void;

interface EphemeralStoreWasm<T extends Value = Value> {
    set(key: string, value: T): void;
    get(key: string): T | undefined;
    getAllStates(): Record<string, T>;
    removeOutdated();
    subscribeLocalUpdates(f: EphemeralLocalListener): () => void;
    subscribe(f: EphemeralListener): () => void;
}

interface EphemeralStoreEvent {
    by: "local" | "import" | "timeout";
    added: string[];
    updated: string[];
    removed: string[];
}



/**
 * `Awareness` is a structure that tracks the ephemeral state of peers.
 *
 * It can be used to synchronize cursor positions, selections, and the names of the peers.
 *
 * The state of a specific peer is expected to be removed after a specified timeout. Use
 * `remove_outdated` to eliminate outdated states.
 */
export class AwarenessWasm {
  free(): void;
  /**
   * Get the timestamp of the state of a given peer.
   */
  getTimestamp(peer: number | bigint | `${number}`): number | undefined;
  /**
   * Remove the states of outdated peers.
   */
  removeOutdated(): PeerID[];
  /**
   * Creates a new `Awareness` instance.
   *
   * The `timeout` parameter specifies the duration in milliseconds.
   * A state of a peer is considered outdated, if the last update of the state of the peer
   * is older than the `timeout`.
   */
  constructor(peer: number | bigint | `${number}`, timeout: number);
  /**
   * Get the PeerID of the local peer.
   */
  peer(): PeerID;
  /**
   * Applies the encoded state of peers.
   *
   * Each peer's deletion countdown will be reset upon update, requiring them to pass through the `timeout`
   * interval again before being eligible for deletion.
   */
  apply(encoded_peers_info: Uint8Array): { updated: PeerID[], added: PeerID[] };
  /**
   * Get all the peers
   */
  peers(): PeerID[];
  /**
   * Encodes the state of the given peers.
   */
  encode(peers: Array<any>): Uint8Array;
  /**
   * Get the number of peers.
   */
  length(): number;
  /**
   * If the state is empty.
   */
  isEmpty(): boolean;
  /**
   * Encodes the state of all peers.
   */
  encodeAll(): Uint8Array;
}
export class ChangeModifier {
  private constructor();
  free(): void;
  setMessage(message: string): ChangeModifier;
  setTimestamp(timestamp: number): ChangeModifier;
}
/**
 * Cursor is a stable position representation in the doc.
 * When expressing the position of a cursor, using "index" can be unstable
 * because the cursor's position may change due to other deletions and insertions,
 * requiring updates with each edit. To stably represent a position or range within
 * a list structure, we can utilize the ID of each item/character on List CRDT or
 * Text CRDT for expression.
 *
 * Loro optimizes State metadata by not storing the IDs of deleted elements. This
 * approach complicates tracking cursors since they rely on these IDs. The solution
 * recalculates position by replaying relevant history to update cursors
 * accurately. To minimize the performance impact of history replay, the system
 * updates cursor info to reference only the IDs of currently present elements,
 * thereby reducing the need for replay.
 *
 * @example
 * ```ts
 *
 * const doc = new LoroDoc();
 * const text = doc.getText("text");
 * text.insert(0, "123");
 * const pos0 = text.getCursor(0, 0);
 * {
 *   const ans = doc.getCursorPos(pos0!);
 *   expect(ans.offset).toBe(0);
 * }
 * text.insert(0, "1");
 * {
 *   const ans = doc.getCursorPos(pos0!);
 *   expect(ans.offset).toBe(1);
 * }
 * ```
 */
export class Cursor {
  private constructor();
  free(): void;
  /**
   * Get the id of the given container.
   */
  containerId(): ContainerID;
  /**
   * Get the ID that represents the position.
   *
   * It can be undefined if it's not bind into a specific ID.
   */
  pos(): { peer: PeerID, counter: number } | undefined;
  /**
   * "Cursor"
   */
  kind(): any;
  /**
   * Get which side of the character/list item the cursor is on.
   */
  side(): Side;
  /**
   * Decode the cursor from a Uint8Array.
   */
  static decode(data: Uint8Array): Cursor;
  /**
   * Encode the cursor into a Uint8Array.
   */
  encode(): Uint8Array;
}
export class EphemeralStoreWasm {
  free(): void;
  getAllStates(): any;
  removeOutdated(): void;
  get(key: string): any;
  /**
   * Creates a new `EphemeralStore` instance.
   *
   * The `timeout` parameter specifies the duration in milliseconds.
   * A state of a peer is considered outdated, if the last update of the state of the peer
   * is older than the `timeout`.
   */
  constructor(timeout: number);
  set(key: string, value: any): void;
  keys(): string[];
  apply(data: Uint8Array): void;
  delete(key: string): void;
  encode(key: string): Uint8Array;
  /**
   * If the state is empty.
   */
  isEmpty(): boolean;
  encodeAll(): Uint8Array;
}
/**
 * The handler of a counter container.
 */
export class LoroCounter {
  free(): void;
  /**
   * Whether the container is attached to a docuemnt.
   *
   * If it's detached, the operations on the container will not be persisted.
   */
  isAttached(): boolean;
  /**
   * Get the attached container associated with this.
   *
   * Returns an attached `Container` that equals to this or created by this, otherwise `undefined`.
   */
  getAttached(): LoroTree | undefined;
  /**
   * Get the value of the counter.
   */
  getShallowValue(): number;
  /**
   * Create a new LoroCounter.
   */
  constructor();
  /**
   * "Counter"
   */
  kind(): 'Counter';
  /**
   * Get the parent container of the counter container.
   *
   * - The parent container of the root counter is `undefined`.
   * - The object returned is a new js object each time because it need to cross
   *   the WASM boundary.
   */
  parent(): Container | undefined;
  toJSON(): number;
  /**
   * Decrement the counter by the given value.
   */
  decrement(value: number): void;
  /**
   * Increment the counter by the given value.
   */
  increment(value: number): void;
  /**
   * Subscribe to the changes of the counter.
   */
  subscribe(f: Function): any;
  /**
   * The container id of this handler.
   */
  readonly id: ContainerID;
  /**
   * Get the value of the counter.
   */
  readonly value: number;
}
/**
 * The CRDTs document. Loro supports different CRDTs include [**List**](LoroList),
 * [**RichText**](LoroText), [**Map**](LoroMap) and [**Movable Tree**](LoroTree),
 * you could build all kind of applications by these.
 *
 * **Important:** Loro is a pure library and does not handle network protocols.
 * It is the responsibility of the user to manage the storage, loading, and synchronization
 * of the bytes exported by Loro in a manner suitable for their specific environment.
 *
 * @example
 * ```ts
 * import { LoroDoc } from "loro-crdt"
 *
 * const loro = new LoroDoc();
 * const text = loro.getText("text");
 * const list = loro.getList("list");
 * const map = loro.getMap("Map");
 * const tree = loro.getTree("tree");
 * ```
 */
export class LoroDoc {
  free(): void;
  /**
   * Apply a batch of diff to the document
   *
   * A diff batch represents a set of changes between two versions of the document.
   * You can calculate a diff batch using `doc.diff()`.
   *
   * Changes are associated with container IDs. During diff application, if new containers were created in the source
   * document, they will be assigned fresh IDs in the target document. Loro automatically handles remapping these
   * container IDs from their original IDs to the new IDs as the diff is applied.
   *
   * @example
   * ```ts
   * const doc1 = new LoroDoc();
   * const doc2 = new LoroDoc();
   *
   * // Make some changes to doc1
   * const text = doc1.getText("text");
   * text.insert(0, "Hello");
   *
   * // Calculate diff between empty and current state
   * const diff = doc1.diff([], doc1.frontiers());
   *
   * // Apply changes to doc2
   * doc2.applyDiff(diff);
   * console.log(doc2.getText("text").toString()); // "Hello"
   * ```
   */
  applyDiff(diff: [ContainerID, Diff|JsonDiff][]): void;
  /**
   * Check if the doc contains the full history.
   */
  isShallow(): boolean;
  /**
   * Get the number of changes in the oplog.
   */
  changeCount(): number;
  /**
   * Get the value or container at the given path
   *
   * The path can be specified in different ways depending on the container type:
   *
   * For Tree:
   * 1. Using node IDs: `tree/{node_id}/property`
   * 2. Using indices: `tree/0/1/property`
   *
   * For List and MovableList:
   * - Using indices: `list/0` or `list/1/property`
   *
   * For Map:
   * - Using keys: `map/key` or `map/nested/property`
   *
   * For tree structures, index-based paths follow depth-first traversal order.
   * The indices start from 0 and represent the position of a node among its siblings.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const map = doc.getMap("map");
   * map.set("key", 1);
   * console.log(doc.getByPath("map/key")); // 1
   * console.log(doc.getByPath("map"));     // LoroMap
   * ```
   */
  getByPath(path: string): Value | Container | undefined;
  /**
   * Get a LoroCounter by container id
   *
   * If the container does not exist, an error will be thrown.
   */
  getCounter(cid: ContainerID | string): LoroCounter;
  /**
   * `detached` indicates that the `DocState` is not synchronized with the latest version of `OpLog`.
   *
   * > The document becomes detached during a `checkout` operation.
   * > Being `detached` implies that the `DocState` is not synchronized with the latest version of the `OpLog`.
   * > In a detached state, the document is not editable by default, and any `import` operations will be
   * > recorded in the `OpLog` without being applied to the `DocState`.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * const frontiers = doc.frontiers();
   * text.insert(0, "Hello World!");
   * console.log(doc.isDetached());  // false
   * doc.checkout(frontiers);
   * console.log(doc.isDetached());  // true
   * doc.attach();
   * console.log(doc.isDetached());  // false
   * ```
   */
  isDetached(): boolean;
  /**
   * Set the peer ID of the current writer.
   *
   * It must be a number, a BigInt, or a decimal string that can be parsed to a unsigned 64-bit integer.
   *
   * Note: use it with caution. You need to make sure there is not chance that two peers
   * have the same peer ID. Otherwise, we cannot ensure the consistency of the document.
   */
  setPeerId(peer_id: number | bigint | `${number}`): void;
  /**
   * Get the absolute position of the given Cursor
   *
   * @example
   * ```ts
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insert(0, "123");
   * const pos0 = text.getCursor(0, 0);
   * {
   *    const ans = doc.getCursorPos(pos0!);
   *    expect(ans.offset).toBe(0);
   * }
   * text.insert(0, "1");
   * {
   *    const ans = doc.getCursorPos(pos0!);
   *    expect(ans.offset).toBe(1);
   * }
   * ```
   */
  getCursorPos(cursor: Cursor): { update?: Cursor, offset: number, side: Side } | undefined;
  /**
   * Check if the doc contains the target container.
   *
   * A root container always exists, while a normal container exists
   * if it has ever been created on the doc.
   *
   * @example
   * ```ts
   * import { LoroDoc, LoroMap, LoroText, LoroList } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * doc.setPeerId("1");
   * const text = doc.getMap("map").setContainer("text", new LoroText());
   * const list = doc.getMap("map").setContainer("list", new LoroList());
   * expect(doc.isContainerExists("cid:root-map:Map")).toBe(true);
   * expect(doc.isContainerExists("cid:0@1:Text")).toBe(true);
   * expect(doc.isContainerExists("cid:1@1:List")).toBe(true);
   *
   * const doc2 = new LoroDoc();
   * // Containers exist, as long as the history or the doc state include it
   * doc.detach();
   * doc2.import(doc.export({ mode: "update" }));
   * expect(doc2.isContainerExists("cid:root-map:Map")).toBe(true);
   * expect(doc2.isContainerExists("cid:0@1:Text")).toBe(true);
   * expect(doc2.isContainerExists("cid:1@1:List")).toBe(true);
   * ```
   */
  hasContainer(container_id: ContainerID): boolean;
  /**
   * Import a batch of updates or snapshots.
   *
   * It's more efficient than importing updates one by one.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insert(0, "Hello");
   * const updates = doc.export({ mode: "update" });
   * const snapshot = doc.export({ mode: "snapshot" });
   * const doc2 = new LoroDoc();
   * doc2.importBatch([snapshot, updates]);
   * ```
   */
  importBatch(data: Uint8Array[]): ImportStatus;
  /**
   * Compare the ordering of two Frontiers.
   *
   * It's assumed that both Frontiers are included by the doc. Otherwise, an error will be thrown.
   *
   * Return value:
   *
   * - -1: a < b
   * - 0: a == b
   * - 1: a > b
   * - undefined: a ∥ b: a and b are concurrent
   */
  cmpFrontiers(a: ({ peer: PeerID, counter: number })[], b: ({ peer: PeerID, counter: number })[]): -1 | 1 | 0 | undefined;
  /**
   * Debug the size of the history
   */
  debugHistory(): void;
  /**
   * Create a loro document from the snapshot.
   *
   * @see You can learn more [here](https://loro.dev/docs/tutorial/encoding).
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt"
   *
   * const doc = new LoroDoc();
   * // ...
   * const bytes = doc.export({ mode: "snapshot" });
   * const loro = LoroDoc.fromSnapshot(bytes);
   * ```
   */
  static fromSnapshot(snapshot: Uint8Array): LoroDoc;
  /**
   * Get the change that contains the specific ID
   */
  getChangeAt(id: { peer: PeerID, counter: number }): Change;
  /**
   * Get the version vector of the latest known version in OpLog.
   *
   * If you checkout to a specific version, this version vector will not change.
   */
  oplogVersion(): VersionVector;
  /**
   * Convert frontiers to a version vector
   *
   * Learn more about frontiers and version vector [here](https://loro.dev/docs/advanced/version_deep_dive)
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insert(0, "Hello");
   * const frontiers = doc.frontiers();
   * const version = doc.frontiersToVV(frontiers);
   * ```
   */
  frontiersToVV(frontiers: ({ peer: PeerID, counter: number })[]): VersionVector;
  /**
   * Get all of changes in the oplog.
   *
   * Note: this method is expensive when the oplog is large. O(n)
   *
   * @example
   * ```ts
   * import { LoroDoc, LoroText } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insert(0, "Hello");
   * const changes = doc.getAllChanges();
   *
   * for (let [peer, c] of changes.entries()){
   *     console.log("peer: ", peer);
   *     for (let change of c){
   *         console.log("change: ", change);
   *     }
   * }
   * ```
   */
  getAllChanges(): Map<PeerID, Change[]>;
  /**
   * Get the [frontiers](https://loro.dev/docs/advanced/version_deep_dive) of the latest version in OpLog.
   *
   * If you checkout to a specific version, this value will not change.
   */
  oplogFrontiers(): { peer: PeerID, counter: number }[];
  /**
   * Convert a version vector to frontiers
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insert(0, "Hello");
   * const version = doc.version();
   * const frontiers = doc.vvToFrontiers(version);
   * ```
   */
  vvToFrontiers(vv: VersionVector): { peer: PeerID, counter: number }[];
  /**
   * The doc only contains the history since this version
   *
   * This is empty if the doc is not shallow.
   *
   * The ops included by the shallow history start version vector are not in the doc.
   */
  shallowSinceVV(): VersionVector;
  /**
   * Set the rich text format configuration of the document.
   *
   * You need to config it if you use rich text `mark` method.
   * Specifically, you need to config the `expand` property of each style.
   *
   * Expand is used to specify the behavior of expanding when new text is inserted at the
   * beginning or end of the style.
   *
   * You can specify the `expand` option to set the behavior when inserting text at the boundary of the range.
   *
   * - `after`(default): when inserting text right after the given range, the mark will be expanded to include the inserted text
   * - `before`: when inserting text right before the given range, the mark will be expanded to include the inserted text
   * - `none`: the mark will not be expanded to include the inserted text at the boundaries
   * - `both`: when inserting text either right before or right after the given range, the mark will be expanded to include the inserted text
   *
   * @example
   * ```ts
   * const doc = new LoroDoc();
   * doc.configTextStyle({
   *   bold: { expand: "after" },
   *   link: { expand: "before" }
   * });
   * const text = doc.getText("text");
   * text.insert(0, "Hello World!");
   * text.mark({ start: 0, end: 5 }, "bold", true);
   * expect(text.toDelta()).toStrictEqual([
   *   {
   *     insert: "Hello",
   *     attributes: {
   *       bold: true,
   *     },
   *   },
   *   {
   *     insert: " World!",
   *   },
   * ] as Delta<string>[]);
   * ```
   */
  configTextStyle(styles: {[key: string]: { expand: 'before'|'after'|'none'|'both' }}): void;
  /**
   * Get all ops of the change that contains the specific ID
   */
  getOpsInChange(id: { peer: PeerID, counter: number }): any[];
  /**
   * Get the shallow json format of the document state.
   *
   * Unlike `toJSON()` which recursively resolves all containers to their values,
   * `getShallowValue()` returns container IDs as strings for any nested containers.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const list = doc.getList("list");
   * const tree = doc.getTree("tree");
   * const map = doc.getMap("map");
   * const shallowValue = doc.getShallowValue();
   * console.log(shallowValue);
   * // {
   * //   list: 'cid:root-list:List',
   * //   tree: 'cid:root-tree:Tree',
   * //   map: 'cid:root-map:Map'
   * // }
   *
   * // It points to the same container as `list`
   * const listB = doc.getContainerById(shallowValue.list);
   * ```
   */
  getShallowValue(): Record<string, ContainerID>;
  /**
   * Checkout the `DocState` to the latest version of `OpLog`.
   *
   * > The document becomes detached during a `checkout` operation.
   * > Being `detached` implies that the `DocState` is not synchronized with the latest version of the `OpLog`.
   * > In a detached state, the document is not editable by default, and any `import` operations will be
   * > recorded in the `OpLog` without being applied to the `DocState`.
   *
   * This has the same effect as `attach`.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * const frontiers = doc.frontiers();
   * text.insert(0, "Hello World!");
   * doc.checkout(frontiers);
   * // you need call `checkoutToLatest()` or `attach()` before changing the doc.
   * doc.checkoutToLatest();
   * text.insert(0, "Hi");
   * ```
   */
  checkoutToLatest(): void;
  /**
   * Compare the version of the OpLog with the specified frontiers.
   *
   * This method is useful to compare the version by only a small amount of data.
   *
   * This method returns an integer indicating the relationship between the version of the OpLog (referred to as 'self')
   * and the provided 'frontiers' parameter:
   *
   * - -1: The version of 'self' is either less than 'frontiers' or is non-comparable (parallel) to 'frontiers',
   *        indicating that it is not definitively less than 'frontiers'.
   * - 0: The version of 'self' is equal to 'frontiers'.
   * - 1: The version of 'self' is greater than 'frontiers'.
   *
   * # Internal
   *
   * Frontiers cannot be compared without the history of the OpLog.
   */
  cmpWithFrontiers(frontiers: ({ peer: PeerID, counter: number })[]): number;
  /**
   * Delete all content from a root container and hide it from the document.
   *
   * When a root container is empty and hidden:
   * - It won't show up in `get_deep_value()` results
   * - It won't be included in document snapshots
   *
   * Only works on root containers (containers without parents).
   */
  deleteRootContainer(cid: ContainerID): void;
  /**
   * Get the number of operations in the pending transaction.
   *
   * The pending transaction is the one that is not committed yet. It will be committed
   * automatically after calling `doc.commit()`, `doc.export(mode)` or `doc.checkout(version)`.
   */
  getPendingTxnLength(): number;
  /**
   * Import updates from the JSON format.
   *
   * only supports backward compatibility but not forward compatibility.
   */
  importJsonUpdates(json: string | JsonSchema): ImportStatus;
  /**
   * Import a batch of updates and snapshots.
   *
   * It's more efficient than importing updates one by one.
   *
   * @deprecated Use `importBatch` instead.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insert(0, "Hello");
   * const updates = doc.export({ mode: "update" });
   * const snapshot = doc.export({ mode: "snapshot" });
   * const doc2 = new LoroDoc();
   * doc2.importBatch([snapshot, updates]);
   * ```
   */
  importUpdateBatch(data: Uint8Array[]): ImportStatus;
  /**
   * Enables editing in detached mode, which is disabled by default.
   *
   * The doc enter detached mode after calling `detach` or checking out a non-latest version.
   *
   * # Important Notes:
   *
   * - This mode uses a different PeerID for each checkout.
   * - Ensure no concurrent operations share the same PeerID if set manually.
   * - Importing does not affect the document's state or version; changes are
   *   recorded in the [OpLog] only. Call `checkout` to apply changes.
   */
  setDetachedEditing(enable: boolean): void;
  /**
   * Set whether to record the timestamp of each change. Default is `false`.
   *
   * If enabled, the Unix timestamp (in seconds) will be recorded for each change automatically.
   *
   * You can also set each timestamp manually when you commit a change.
   * The timestamp manually set will override the automatic one.
   *
   * NOTE: Timestamps are forced to be in ascending order in the OpLog's history.
   * If you commit a new change with a timestamp that is less than the existing one,
   * the largest existing timestamp will be used instead.
   */
  setRecordTimestamp(auto_record: boolean): void;
  /**
   * Find the op id spans that between the `from` version and the `to` version.
   *
   * You can combine it with `exportJsonInIdSpan` to get the changes between two versions.
   *
   * You can use it to travel all the changes from `from` to `to`. `from` and `to` are frontiers,
   * and they can be concurrent to each other. You can use it to find all the changes related to an event:
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const docA = new LoroDoc();
   * docA.setPeerId("1");
   * const docB = new LoroDoc();
   *
   * docA.getText("text").update("Hello");
   * docA.commit();
   * const snapshot = docA.export({ mode: "snapshot" });
   * let done = false;
   * docB.subscribe(e => {
   *   const spans = docB.findIdSpansBetween(e.from, e.to);
   *   const changes = docB.exportJsonInIdSpan(spans.forward[0]);
   *   console.log(changes);
   *   // [{
   *   //   id: "0@1",
   *   //   timestamp: expect.any(Number),
   *   //   deps: [],
   *   //   lamport: 0,
   *   //   msg: undefined,
   *   //   ops: [{
   *   //     container: "cid:root-text:Text",
   *   //     counter: 0,
   *   //     content: {
   *   //       type: "insert",
   *   //       pos: 0,
   *   //       text: "Hello"
   *   //     }
   *   //   }]
   *   // }]
   * });
   * docB.import(snapshot);
   * ```
   */
  findIdSpansBetween(from: ({ peer: PeerID, counter: number })[], to: ({ peer: PeerID, counter: number })[]): VersionVectorDiff;
  /**
   * Get the change of with specific peer_id and lamport <= given lamport
   */
  getChangeAtLamport(peer_id: string, lamport: number): Change | undefined;
  /**
   * Get the path from the root to the container
   */
  getPathToContainer(id: ContainerID): (string|number)[] | undefined;
  /**
   * Gets container IDs modified in the given ID range.
   *
   * **NOTE:** This method will implicitly commit.
   *
   * This method identifies which containers were affected by changes in a given range of operations.
   * It can be used together with `doc.travelChangeAncestors()` to analyze the history of changes
   * and determine which containers were modified by each change.
   *
   * @param id - The starting ID of the change range
   * @param len - The length of the change range to check
   * @returns An array of container IDs that were modified in the given range
   */
  getChangedContainersIn(id: { peer: PeerID, counter: number }, len: number): ContainerID[];
  /**
   * Get deep value of the document with container id
   */
  getDeepValueWithID(): any;
  /**
   * Set the origin of the next commit
   */
  setNextCommitOrigin(origin: string): void;
  /**
   * Get the pending operations from the current transaction in JSON format
   *
   * This method returns a JSON representation of operations that have been applied
   * but not yet committed in the current transaction.
   *
   * It will use the same data format as `doc.exportJsonUpdates()`
   *
   * @example
   * ```ts
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insert(0, "Hello");
   * // Get pending ops before commit
   * const pendingOps = doc.getPendingOpsFromCurrentTxnAsJson();
   * doc.commit();
   * const emptyOps = doc.getPendingOpsFromCurrentTxnAsJson(); // this is undefined
   * ```
   */
  getUncommittedOpsAsJson(): JsonSchema | undefined;
  /**
   * Set the commit message of the next commit
   */
  setNextCommitMessage(msg: string): void;
  /**
   * Set the options of the next commit
   */
  setNextCommitOptions(options: { origin?: string, timestamp?: number, message?: string }): void;
  /**
   * The doc only contains the history since this version
   *
   * This is empty if the doc is not shallow.
   *
   * The ops included by the shallow history start frontiers are not in the doc.
   */
  shallowSinceFrontiers(): { peer: PeerID, counter: number }[];
  /**
   * Visit all the ancestors of the changes in causal order.
   *
   * @param ids - the changes to visit
   * @param f - the callback function, return `true` to continue visiting, return `false` to stop
   */
  travelChangeAncestors(ids: ({ peer: PeerID, counter: number })[], f: (change: Change) => boolean): void;
  /**
   * Clear the options of the next commit
   */
  clearNextCommitOptions(): void;
  /**
   * Configures the default text style for the document.
   *
   * This method sets the default text style configuration for the document when using LoroText.
   * If `None` is provided, the default style is reset.
   */
  configDefaultTextStyle(style: { expand: 'before'|'after'|'none'|'both' } | undefined): void;
  /**
   * If two continuous local changes are within (<=) the interval(**in seconds**), they will be merged into one change.
   *
   * The default value is 1_000 seconds.
   *
   * By default, we record timestamps in seconds for each change. So if the merge interval is 1, and changes A and B
   * have timestamps of 3 and 4 respectively, then they will be merged into one change
   */
  setChangeMergeInterval(interval: number): void;
  /**
   * Set the timestamp of the next commit
   */
  setNextCommitTimestamp(timestamp: number): void;
  /**
   * Set whether to hide empty root containers.
   *
   * @example
   * ```ts
   * const doc = new LoroDoc();
   * const map = doc.getMap("map");
   * console.log(doc.toJSON()); // { map: {} }
   * doc.setHideEmptyRootContainers(true);
   * console.log(doc.toJSON()); // {}
   * ```
   */
  setHideEmptyRootContainers(hide: boolean): void;
  /**
   * Whether the editing is enabled in detached mode.
   *
   * The doc enter detached mode after calling `detach` or checking out a non-latest version.
   *
   * # Important Notes:
   *
   * - This mode uses a different PeerID for each checkout.
   * - Ensure no concurrent operations share the same PeerID if set manually.
   * - Importing does not affect the document's state or version; changes are
   *   recorded in the [OpLog] only. Call `checkout` to apply changes.
   */
  isDetachedEditingEnabled(): boolean;
  /**
   * Create a new loro document.
   *
   * New document will have a random peer id.
   */
  constructor();
  /**
   * Duplicate the document with a different PeerID
   *
   * The time complexity and space complexity of this operation are both O(n),
   *
   * When called in detached mode, it will fork at the current state frontiers.
   * It will have the same effect as `forkAt(&self.frontiers())`.
   */
  fork(): LoroDoc;
  /**
   * Attach the document state to the latest known version.
   *
   * > The document becomes detached during a `checkout` operation.
   * > Being `detached` implies that the `DocState` is not synchronized with the latest version of the `OpLog`.
   * > In a detached state, the document is not editable, and any `import` operations will be
   * > recorded in the `OpLog` without being applied to the `DocState`.
   *
   * This method has the same effect as invoking `checkoutToLatest`.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * const frontiers = doc.frontiers();
   * text.insert(0, "Hello World!");
   * doc.checkout(frontiers);
   * // you need call `attach()` or `checkoutToLatest()` before changing the doc.
   * doc.attach();
   * text.insert(0, "Hi");
   * ```
   */
  attach(): void;
  /**
   * Commit the cumulative auto-committed transaction.
   *
   * You can specify the `origin`, `timestamp`, and `message` of the commit.
   *
   * - The `origin` is used to mark the event
   * - The `message` works like a git commit message, which will be recorded and synced to peers
   * - The `timestamp` is the number of seconds that have elapsed since 00:00:00 UTC on January 1, 1970.
   *   It defaults to `Date.now() / 1000` when timestamp recording is enabled
   *
   * The events will be emitted after a transaction is committed. A transaction is committed when:
   *
   * - `doc.commit()` is called.
   * - `doc.export(mode)` is called.
   * - `doc.import(data)` is called.
   * - `doc.checkout(version)` is called.
   *
   * NOTE: Timestamps are forced to be in ascending order.
   * If you commit a new change with a timestamp that is less than the existing one,
   * the largest existing timestamp will be used instead.
   *
   * NOTE: The `origin` will not be persisted, but the `message` will.
   *
   * Behavior on empty commits:
   * - This method is an explicit commit. If the pending transaction is empty, any provided
   *   options (message/timestamp/origin) are swallowed and will not carry over to the next commit.
   * - Implicit commits triggered by `export`/`checkout` act as processing barriers. If the
   *   transaction is empty in those cases, `message`/`timestamp`/`origin` are preserved for the
   *   next commit.
   */
  commit(options?: { origin?: string, timestamp?: number, message?: string } | null): void;
  /**
   * Detach the document state from the latest known version.
   *
   * After detaching, all import operations will be recorded in the `OpLog` without being applied to the `DocState`.
   * When `detached`, the document is not editable.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * doc.detach();
   * console.log(doc.isDetached());  // true
   * ```
   */
  detach(): void;
  /**
   * Export the document based on the specified ExportMode.
   *
   * @param mode - The export mode to use. Can be one of:
   *   - `{ mode: "snapshot" }`: Export a full snapshot of the document.
   *   - `{ mode: "update", from?: VersionVector }`: Export updates from the given version vector.
   *     If `from` is not provided, it will export the whole history of the document.
   *   - `{ mode: "updates-in-range", spans: { id: ID, len: number }[] }`: Export updates within the specified ID spans.
   *   - `{ mode: "shallow-snapshot", frontiers: Frontiers }`: Export a garbage-collected snapshot up to the given frontiers.
   *
   * @returns A byte array containing the exported data.
   *
   * @example
   * ```ts
   * import { LoroDoc, LoroText } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * doc.setPeerId("1");
   * doc.getText("text").update("Hello World");
   *
   * // Export a full snapshot
   * const snapshotBytes = doc.export({ mode: "snapshot" });
   *
   * // Export updates from a specific version
   * const vv = doc.oplogVersion();
   * doc.getText("text").update("Hello Loro");
   * const updateBytes = doc.export({ mode: "update", from: vv });
   *
   * // Export a shallow snapshot that only includes the history since the frontiers
   * const shallowBytes = doc.export({ mode: "shallow-snapshot", frontiers: doc.oplogFrontiers() });
   *
   * // Export updates within specific ID spans
   * const spanBytes = doc.export({
   *   mode: "updates-in-range",
   *   spans: [{ id: { peer: "1", counter: 0 }, len: 10 }]
   * });
   * ```
   */
  export(mode: ExportMode): Uint8Array;
  /**
   * Import snapshot or updates into current doc.
   *
   * Note:
   * - Updates within the current version will be ignored
   * - Updates with missing dependencies will be pending until the dependencies are received
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insert(0, "Hello");
   * // get all updates of the doc
   * const updates = doc.export({ mode: "update" });
   * const snapshot = doc.export({ mode: "snapshot" });
   * const doc2 = new LoroDoc();
   * // import snapshot
   * doc2.import(snapshot);
   * // or import updates
   * doc2.import(updates);
   * ```
   */
  import(update_or_snapshot: Uint8Array): ImportStatus;
  /**
   * Creates a new LoroDoc at a specified version (Frontiers)
   *
   * The created doc will only contain the history before the specified frontiers.
   */
  forkAt(frontiers: ({ peer: PeerID, counter: number })[]): LoroDoc;
  /**
   * Get the number of ops in the oplog.
   */
  opCount(): number;
  /**
   * Get the json format of the entire document state.
   *
   * Unlike `getShallowValue()` which returns container IDs as strings,
   * `toJSON()` recursively resolves all containers to their actual values.
   *
   * @example
   * ```ts
   * import { LoroDoc, LoroText, LoroMap } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const list = doc.getList("list");
   * list.insert(0, "Hello");
   * const text = list.insertContainer(0, new LoroText());
   * text.insert(0, "Hello");
   * const map = list.insertContainer(1, new LoroMap());
   * map.set("foo", "bar");
   * console.log(doc.toJSON());
   * // {"list": ["Hello", {"foo": "bar"}]}
   * ```
   */
  toJSON(): any;
  /**
   * Get the version vector of the current document state.
   *
   * If you checkout to a specific version, the version vector will change.
   */
  version(): VersionVector;
  /**
   * Checkout the `DocState` to a specific version.
   *
   * > The document becomes detached during a `checkout` operation.
   * > Being `detached` implies that the `DocState` is not synchronized with the latest version of the `OpLog`.
   * > In a detached state, the document is not editable, and any `import` operations will be
   * > recorded in the `OpLog` without being applied to the `DocState`.
   *
   * You should call `attach` to attach the `DocState` to the latest version of `OpLog`.
   *
   * @param frontiers - the specific frontiers
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * const frontiers = doc.frontiers();
   * text.insert(0, "Hello World!");
   * doc.checkout(frontiers);
   * console.log(doc.toJSON()); // {"text": ""}
   * ```
   */
  checkout(frontiers: ({ peer: PeerID, counter: number })[]): void;
  /**
   * Get a LoroText by container id.
   *
   * The object returned is a new js object each time because it need to cross
   * the WASM boundary.
   *
   * If the container does not exist, an error will be thrown.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * ```
   */
  getText(cid: ContainerID | string): LoroText;
  /**
   * Get the [frontiers](https://loro.dev/docs/advanced/version_deep_dive) of the current document state.
   *
   * If you checkout to a specific version, this value will change.
   */
  frontiers(): { peer: PeerID, counter: number }[];
  /**
   * Evaluate JSONPath against a LoroDoc
   */
  JSONPath(jsonpath: string): Array<any>;
  /**
   * Revert the document to the given frontiers.
   *
   * The doc will not become detached when using this method. Instead, it will generate a series
   * of operations to revert the document to the given version.
   *
   * @example
   * ```ts
   * const doc = new LoroDoc();
   * doc.setPeerId("1");
   * const text = doc.getText("text");
   * text.insert(0, "Hello");
   * doc.commit();
   * doc.revertTo([{ peer: "1", counter: 1 }]);
   * expect(doc.getText("text").toString()).toBe("He");
   * ```
   */
  revertTo(frontiers: ({ peer: PeerID, counter: number })[]): void;
  /**
   * Get peer id in decimal string.
   */
  readonly peerIdStr: PeerID;
  /**
   * Peer ID of the current writer.
   */
  readonly peerId: bigint;
}
/**
 * The handler of a list container.
 *
 * Learn more at https://loro.dev/docs/tutorial/list
 */
export class LoroList {
  free(): void;
  /**
   * Whether the container is attached to a document.
   *
   * If it's detached, the operations on the container will not be persisted.
   */
  isAttached(): boolean;
  /**
   * Get the attached container associated with this.
   *
   * Returns an attached `Container` that equals to this or created by this, otherwise `undefined`.
   */
  getAttached(): LoroList | undefined;
  /**
   * Get the shallow value of the list.
   *
   * Unlike `toJSON()` which recursively resolves all containers to their values,
   * `getShallowValue()` returns container IDs as strings for any nested containers.
   *
   * ```js
   * const doc = new LoroDoc();
   * doc.setPeerId("1");
   * const list = doc.getList("list");
   * list.insert(0, 1);
   * list.insert(1, "two");
   * const subList = list.insertContainer(2, new LoroList());
   * subList.insert(0, "sub");
   * list.getShallowValue(); // [1, "two", "cid:2@1:List"]
   * list.toJSON(); // [1, "two", ["sub"]]
   * ```
   */
  getShallowValue(): Value[];
  /**
   * Create a new detached LoroList (not attached to any LoroDoc).
   *
   * The edits on a detached container will not be persisted.
   * To attach the container to the document, please insert it into an attached container.
   */
  constructor();
  /**
   * Pop a value from the end of the list.
   */
  pop(): Value | undefined;
  /**
   * "List"
   */
  kind(): 'List';
  /**
   * Delete all elements in the list.
   */
  clear(): void;
  /**
   * Delete elements from index to index + len.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const list = doc.getList("list");
   * list.insert(0, 100);
   * list.delete(0, 1);
   * console.log(list.value);  // []
   * ```
   */
  delete(index: number, len: number): void;
  /**
   * Get the parent container.
   *
   * - The parent container of the root tree is `undefined`.
   * - The object returned is a new js object each time because it need to cross
   *   the WASM boundary.
   */
  parent(): Container | undefined;
  getIdAt(pos: number): { peer: PeerID, counter: number } | undefined;
  /**
   * Get elements of the list. If the type of a element is a container, it will be
   * resolved recursively.
   *
   * @example
   * ```ts
   * import { LoroDoc, LoroText } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const list = doc.getList("list");
   * list.insert(0, 100);
   * const text = list.insertContainer(1, new LoroText());
   * text.insert(0, "Hello");
   * console.log(list.toJSON());  // [100, "Hello"];
   * ```
   */
  toJSON(): any;
  /**
   * Check if the container is deleted
   */
  isDeleted(): boolean;
  /**
   * Get the id of this container.
   */
  readonly id: ContainerID;
  /**
   * Get the length of list.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const list = doc.getList("list");
   * list.insert(0, 100);
   * list.insert(1, "foo");
   * list.insert(2, true);
   * console.log(list.length);  // 3
   * ```
   */
  readonly length: number;
}
/**
 * The handler of a map container.
 *
 * Learn more at https://loro.dev/docs/tutorial/map
 */
export class LoroMap {
  free(): void;
  /**
   * Whether the container is attached to a document.
   *
   * If it's detached, the operations on the container will not be persisted.
   */
  isAttached(): boolean;
  /**
   * Get the attached container associated with this.
   *
   * Returns an attached `Container` that equals to this or created by this, otherwise `undefined`.
   */
  getAttached(): LoroMap | undefined;
  /**
   * Get the peer id of the last editor on the given entry
   */
  getLastEditor(key: string): PeerID | undefined;
  /**
   * Get the shallow value of the map.
   *
   * Unlike `toJSON()` which recursively resolves all containers to their values,
   * `getShallowValue()` returns container IDs as strings for any nested containers.
   *
   * @example
   * ```ts
   * import { LoroDoc, LoroText } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * doc.setPeerId("1");
   * const map = doc.getMap("map");
   * map.set("key", "value");
   * const subText = map.setContainer("text", new LoroText());
   * subText.insert(0, "Hello");
   *
   * // Get shallow value - nested containers are represented by their IDs
   * console.log(map.getShallowValue());
   * // Output: { key: "value", text: "cid:1@1:Text" }
   *
   * // Get full value with nested containers resolved by `toJSON()`
   * console.log(map.toJSON());
   * // Output: { key: "value", text: "Hello" }
   * ```
   */
  getShallowValue(): Record<string, Value>;
  /**
   * Create a new detached LoroMap (not attached to any LoroDoc).
   *
   * The edits on a detached container will not be persisted.
   * To attach the container to the document, please insert it into an attached container.
   */
  constructor();
  /**
   * Get the keys of the map.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const map = doc.getMap("map");
   * map.set("foo", "bar");
   * map.set("baz", "bar");
   * const keys = map.keys(); // ["foo", "baz"]
   * ```
   */
  keys(): any[];
  /**
   * "Map"
   */
  kind(): 'Map';
  /**
   * Delete all key-value pairs in the map.
   */
  clear(): void;
  /**
   * Remove the key from the map.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const map = doc.getMap("map");
   * map.set("foo", "bar");
   * map.delete("foo");
   * ```
   */
  delete(key: string): void;
  /**
   * Get the parent container.
   *
   * - The parent container of the root tree is `undefined`.
   * - The object returned is a new js object each time because it need to cross
   *   the WASM boundary.
   */
  parent(): Container | undefined;
  /**
   * Get the values of the map. If the value is a child container, the corresponding
   * `Container` will be returned.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const map = doc.getMap("map");
   * map.set("foo", "bar");
   * map.set("baz", "bar");
   * const values = map.values(); // ["bar", "bar"]
   * ```
   */
  values(): any[];
  /**
   * Get the entries of the map. If the value is a child container, the corresponding
   * `Container` will be returned.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const map = doc.getMap("map");
   * map.set("foo", "bar");
   * map.set("baz", "bar");
   * const entries = map.entries(); // [["foo", "bar"], ["baz", "bar"]]
   * ```
   */
  entries(): ([string, Value | Container])[];
  /**
   * Get the keys and the values. If the type of value is a child container,
   * it will be resolved recursively.
   *
   * @example
   * ```ts
   * import { LoroDoc, LoroText } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const map = doc.getMap("map");
   * map.set("foo", "bar");
   * const text = map.setContainer("text", new LoroText());
   * text.insert(0, "Hello");
   * console.log(map.toJSON());  // {"foo": "bar", "text": "Hello"}
   * ```
   */
  toJSON(): any;
  /**
   * Check if the container is deleted
   */
  isDeleted(): boolean;
  /**
   * The container id of this handler.
   */
  readonly id: ContainerID;
  /**
   * Get the size of the map.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const map = doc.getMap("map");
   * map.set("foo", "bar");
   * console.log(map.size);   // 1
   * ```
   */
  readonly size: number;
}
/**
 * The handler of a list container.
 *
 * Learn more at https://loro.dev/docs/tutorial/list
 */
export class LoroMovableList {
  free(): void;
  /**
   * Whether the container is attached to a document.
   *
   * If it's detached, the operations on the container will not be persisted.
   */
  isAttached(): boolean;
  /**
   * Get the creator of the list item at the given position.
   */
  getCreatorAt(pos: number): PeerID | undefined;
  /**
   * Get the attached container associated with this.
   *
   * Returns an attached `Container` that equals to this or created by this, otherwise `undefined`.
   */
  getAttached(): LoroList | undefined;
  /**
   * Get the last mover of the list item at the given position.
   */
  getLastMoverAt(pos: number): PeerID | undefined;
  /**
   * Get the last editor of the list item at the given position.
   */
  getLastEditorAt(pos: number): PeerID | undefined;
  /**
   * Get the shallow value of the movable list.
   *
   * Unlike `toJSON()` which recursively resolves all containers to their values,
   * `getShallowValue()` returns container IDs as strings for any nested containers.
   *
   * ```js
   * const doc = new LoroDoc();
   * doc.setPeerId("1");
   * const list = doc.getMovableList("list");
   * list.insert(0, 1);
   * list.insert(1, "two");
   * const subList = list.insertContainer(2, new LoroList());
   * subList.insert(0, "sub");
   * list.getShallowValue(); // [1, "two", "cid:2@1:List"]
   * list.toJSON(); // [1, "two", ["sub"]]
   * ```
   */
  getShallowValue(): Value[];
  /**
   * Move the element from `from` to `to`.
   *
   * The new position of the element will be `to`.
   * Move the element from `from` to `to`.
   *
   * The new position of the element will be `to`. This method is optimized to prevent redundant
   * operations that might occur with a naive remove and insert approach. Specifically, it avoids
   * creating surplus values in the list, unlike a delete followed by an insert, which can lead to
   * additional values in cases of concurrent edits. This ensures more efficient and accurate
   * operations in a MovableList.
   */
  move(from: number, to: number): void;
  /**
   * Create a new detached LoroMovableList (not attached to any LoroDoc).
   *
   * The edits on a detached container will not be persisted.
   * To attach the container to the document, please insert it into an attached container.
   */
  constructor();
  /**
   * Pop a value from the end of the list.
   */
  pop(): Value | undefined;
  /**
   * "MovableList"
   */
  kind(): 'MovableList';
  /**
   * Delete all elements in the list.
   */
  clear(): void;
  /**
   * Delete elements from index to index + len.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const list = doc.getList("list");
   * list.insert(0, 100);
   * list.delete(0, 1);
   * console.log(list.value);  // []
   * ```
   */
  delete(index: number, len: number): void;
  /**
   * Get the parent container.
   *
   * - The parent container of the root tree is `undefined`.
   * - The object returned is a new js object each time because it need to cross
   *   the WASM boundary.
   */
  parent(): Container | undefined;
  /**
   * Get elements of the list. If the type of a element is a container, it will be
   * resolved recursively.
   *
   * @example
   * ```ts
   * import { LoroDoc, LoroText } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const list = doc.getList("list");
   * list.insert(0, 100);
   * const text = list.insertContainer(1, new LoroText());
   * text.insert(0, "Hello");
   * console.log(list.toJSON());  // [100, "Hello"];
   * ```
   */
  toJSON(): any;
  /**
   * Check if the container is deleted
   */
  isDeleted(): boolean;
  /**
   * Get the id of this container.
   */
  readonly id: ContainerID;
  /**
   * Get the length of list.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const list = doc.getList("list");
   * list.insert(0, 100);
   * list.insert(1, "foo");
   * list.insert(2, true);
   * console.log(list.length);  // 3
   * ```
   */
  readonly length: number;
}
/**
 * The handler of a text container. It supports rich text CRDT.
 *
 * Learn more at https://loro.dev/docs/tutorial/text
 */
export class LoroText {
  free(): void;
  /**
   * Change the state of this text by delta.
   *
   * If a delta item is `insert`, it should include all the attributes of the inserted text.
   * Loro's rich text CRDT may make the inserted text inherit some styles when you use
   * `insert` method directly. However, when you use `applyDelta` if some attributes are
   * inherited from CRDT but not included in the delta, they will be removed.
   *
   * Another special property of `applyDelta` is if you format an attribute for ranges out of
   * the text length, Loro will insert new lines to fill the gap first. It's useful when you
   * build the binding between Loro and rich text editors like Quill, which might assume there
   * is always a newline at the end of the text implicitly.
   *
   * @example
   * ```ts
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * doc.configTextStyle({bold: {expand: "after"}});
   * text.insert(0, "Hello World!");
   * text.mark({ start: 0, end: 5 }, "bold", true);
   * const delta = text.toDelta();
   * const text2 = doc.getText("text2");
   * text2.applyDelta(delta);
   * expect(text2.toDelta()).toStrictEqual(delta);
   * ```
   */
  applyDelta(delta: Delta<string>[]): void;
  /**
   * Convert a position between coordinate systems.
   *
   * Supported values: `"unicode"`, `"utf16"`, `"utf8"`.
   *
   * Returns `undefined` when out of bounds or unsupported.
   */
  convertPos(index: number, from: string, to: string): any;
  /**
   * Delete elements from index to utf-8 index + len
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insertUtf8(0, "Hello");
   * text.deleteUtf8(1, 3);
   * const s = text.toString();
   * console.log(s); // "Ho"
   * ```
   */
  deleteUtf8(index: number, len: number): void;
  /**
   * Get the editor of the text at the given position.
   */
  getEditorOf(pos: number): PeerID | undefined;
  /**
   * Insert some string at utf-8 index.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insertUtf8(0, "Hello");
   * ```
   */
  insertUtf8(index: number, content: string): void;
  /**
   * Whether the container is attached to a LoroDoc.
   *
   * If it's detached, the operations on the container will not be persisted.
   */
  isAttached(): boolean;
  /**
   * Get the rich text delta in the given range (utf-16 index).
   */
  sliceDelta(start: number, end: number): Delta<string>[];
  /**
   * Get the attached container associated with this.
   *
   * Returns an attached `Container` that is equal to this or created by this; otherwise, it returns `undefined`.
   */
  getAttached(): LoroText | undefined;
  /**
   * Get the rich text delta in the given range (utf-8 index).
   */
  sliceDeltaUtf8(start: number, end: number): Delta<string>[];
  /**
   * Get the shallow value of the text. This equals to `text.toString()`.
   */
  getShallowValue(): string;
  /**
   * Create a new detached LoroText (not attached to any LoroDoc).
   *
   * The edits on a detached container will not be persisted.
   * To attach the container to the document, please insert it into an attached container.
   */
  constructor();
  /**
   * Iterate each text span(internal storage unit)
   *
   * The callback function will be called for each span in the text.
   * If the callback returns `false`, the iteration will stop.
   *
   * The current text chunks are snapshotted before callbacks run, so the callback
   * may read or mutate the document without re-entering internal state locks.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insert(0, "Hello");
   * text.iter((str) => (console.log(str), true));
   * ```
   */
  iter(callback: (string) => boolean): void;
  /**
   * "Text"
   */
  kind(): 'Text';
  /**
   * Mark a range of text with a key and a value (utf-16 index).
   *
   * > You should call `configTextStyle` before using `mark` and `unmark`.
   *
   * You can use it to create a highlight, make a range of text bold, or add a link to a range of text.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * doc.configTextStyle({bold: {expand: "after"}});
   * const text = doc.getText("text");
   * text.insert(0, "Hello World!");
   * text.mark({ start: 0, end: 5 }, "bold", true);
   * ```
   */
  mark(range: { start: number, end: number }, key: string, value: any): void;
  /**
   * Push a string to the end of the text.
   */
  push(s: string): void;
  /**
   * Get a string slice (utf-16 index).
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insert(0, "Hello");
   * text.slice(0, 2); // "He"
   * ```
   */
  slice(start_index: number, end_index: number): string;
  /**
   * Delete elements from index to index + len (utf-16 index).
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insert(0, "Hello");
   * text.delete(1, 3);
   * const s = text.toString();
   * console.log(s); // "Ho"
   * ```
   */
  delete(index: number, len: number): void;
  /**
   * Insert the string at the given index (utf-16 index).
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insert(0, "Hello");
   * ```
   */
  insert(index: number, content: string): void;
  /**
   * Get the parent container.
   *
   * - The parent of the root is `undefined`.
   * - The object returned is a new js object each time because it need to cross
   *   the WASM boundary.
   */
  parent(): Container | undefined;
  /**
   * Delete and return the string at the given range and insert a string at the same position (utf-16 index).
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insert(0, "Hello");
   * text.splice(2, 3, "llo"); // "llo"
   * ```
   */
  splice(pos: number, len: number, s: string): string;
  /**
   * Unmark a range of text with a key and a value (utf-16 index).
   *
   * > You should call `configTextStyle` before using `mark` and `unmark`.
   *
   * You can use it to remove highlights, bolds or links
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * doc.configTextStyle({bold: {expand: "after"}});
   * const text = doc.getText("text");
   * text.insert(0, "Hello World!");
   * text.mark({ start: 0, end: 5 }, "bold", true);
   * text.unmark({ start: 0, end: 5 }, "bold");
   * ```
   */
  unmark(range: { start: number, end: number }, key: string): void;
  /**
   * Get the character at the given position (utf-16 index).
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * text.insert(0, "Hello");
   * text.charAt(0); // "H"
   * ```
   */
  charAt(pos: number): string;
  /**
   * Get the JSON representation of the text.
   */
  toJSON(): any;
  /**
   * Get the text in [Delta](https://quilljs.com/docs/delta/) format.
   *
   * The returned value will include the rich text information.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const text = doc.getText("text");
   * doc.configTextStyle({bold: {expand: "after"}});
   * text.insert(0, "Hello World!");
   * text.mark({ start: 0, end: 5 }, "bold", true);
   * console.log(text.toDelta());  // [ { insert: 'Hello', attributes: { bold: true } } ]
   * ```
   */
  toDelta(): Delta<string>[];
  /**
   * Check if the container is deleted
   */
  isDeleted(): boolean;
  /**
   * Convert the text to a string
   */
  toString(): string;
  /**
   * Get the container id of the text.
   */
  readonly id: ContainerID;
  /**
   * Get the length of text (utf-16 length).
   */
  readonly length: number;
}
/**
 * The handler of a tree(forest) container.
 *
 * Learn more at https://loro.dev/docs/tutorial/tree
 */
export class LoroTree {
  free(): void;
  /**
   * Whether the container is attached to a document.
   *
   * If it's detached, the operations on the container will not be persisted.
   */
  isAttached(): boolean;
  /**
   * Get the attached container associated with this.
   *
   * Returns an attached `Container` that equals to this or created by this, otherwise `undefined`.
   */
  getAttached(): LoroTree | undefined;
  /**
   * Return `None` if the node is not exist, otherwise return `Some(true)` if the node is deleted.
   */
  isNodeDeleted(target: TreeID): boolean;
  /**
   * Get the shallow value of the tree.
   *
   * Unlike `toJSON()` which recursively resolves nested containers to their values,
   * `getShallowValue()` returns container IDs as strings for any nested containers.
   *
   * @example
   * ```ts
   * const doc = new LoroDoc();
   * doc.setPeerId("1");
   * const tree = doc.getTree("tree");
   * const root = tree.createNode();
   * root.data.set("name", "root");
   * const text = root.data.setContainer("content", new LoroText());
   * text.insert(0, "Hello");
   *
   * console.log(tree.getShallowValue());
   * // [{
   * //   id: "0@1",
   * //   parent: null,
   * //   index: 0,
   * //   fractional_index: "80",
   * //   meta: "cid:0@1:Map",
   * //   children: []
   * // }]
   *
   * console.log(tree.toJSON());
   * // [{
   * //   id: "0@1",
   * //   parent: null,
   * //   index: 0,
   * //   fractional_index: "80",
   * //   meta: {
   * //     name: "root",
   * //     content: "Hello"
   * //   },
   * //   children: []
   * // }]
   * ```
   */
  getShallowValue(): TreeNodeShallowValue[];
  /**
   * Set whether to generate a fractional index for moving and creating.
   *
   * A fractional index can be used to determine the position of tree nodes among their siblings.
   *
   * The jitter is used to avoid conflicts when multiple users are creating a node at the same position.
   * A value of 0 is the default, which means no jitter; any value larger than 0 will enable jitter.
   *
   * Generally speaking, higher jitter value will increase the size of the operation
   * [Read more about it](https://www.loro.dev/blog/movable-tree#implementation-and-encoding-size)
   */
  enableFractionalIndex(jitter: number): void;
  /**
   * Disable the fractional index generation when you don't need the Tree's siblings to be sorted.
   * The fractional index will always be set to the same default value 0.
   *
   * After calling this, you cannot use `tree.moveTo()`, `tree.moveBefore()`, `tree.moveAfter()`,
   * and `tree.createAt()`.
   */
  disableFractionalIndex(): void;
  /**
   * Whether the tree enables the fractional index generation.
   */
  isFractionalIndexEnabled(): boolean;
  /**
   * Move the target tree node to be a child of the parent.
   * It's not allowed that the target is an ancestor of the parent
   * or the target and the parent are the same node.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const tree = doc.getTree("tree");
   * const root = tree.createNode();
   * const node = root.createNode();
   * const node2 = node.createNode();
   * tree.move(node2.id, root.id);
   * // Error will be thrown if move operation creates a cycle
   * // tree.move(root.id, node.id);
   * ```
   */
  move(target: TreeID, parent: TreeID | undefined, index?: number | null): void;
  /**
   * Create a new detached LoroTree (not attached to any LoroDoc).
   *
   * The edits on a detached container will not be persisted.
   * To attach the container to the document, please insert it into an attached container.
   */
  constructor();
  /**
   * "Tree"
   */
  kind(): 'Tree';
  /**
   * Get all tree nodes of the forest, including deleted nodes.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const tree = doc.getTree("tree");
   * const root = tree.createNode();
   * const node = root.createNode();
   * const node2 = node.createNode();
   * console.log(tree.nodes());
   * ```
   */
  nodes(): LoroTreeNode[];
  /**
   * Get the root nodes of the forest.
   */
  roots(): LoroTreeNode[];
  /**
   * Delete a tree node from the forest.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const tree = doc.getTree("tree");
   * const root = tree.createNode();
   * const node = root.createNode();
   * tree.delete(node.id);
   * ```
   */
  delete(target: TreeID): void;
  /**
   * Get the parent container of the tree container.
   *
   * - The parent container of the root tree is `undefined`.
   * - The object returned is a new js object each time because it need to cross
   *   the WASM boundary.
   */
  parent(): Container | undefined;
  /**
   * Get the hierarchy array with metadata of the forest.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const tree = doc.getTree("tree");
   * const root = tree.createNode();
   * root.data.set("color", "red");
   * // [ { id: '0@F2462C4159C4C8D1', parent: null, meta: { color: 'red' }, children: [] } ]
   * console.log(tree.toJSON());
   * ```
   */
  toJSON(): any;
  /**
   * Return `true` if the tree contains the TreeID, include deleted node.
   */
  has(target: TreeID): boolean;
  /**
   * Check if the container is deleted
   */
  isDeleted(): boolean;
  /**
   * Get the id of the container.
   */
  readonly id: ContainerID;
}
/**
 * The handler of a tree node.
 */
export class LoroTreeNode {
  private constructor();
  free(): void;
  /**
   * Get the creation id of this node.
   */
  creationId(): { peer: PeerID, counter: number };
  /**
   * Check if the node is deleted.
   */
  isDeleted(): boolean;
  /**
   * Move the tree node to be before the target node.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const tree = doc.getTree("tree");
   * const root = tree.createNode();
   * const node = root.createNode();
   * const node2 = root.createNode();
   * node2.moveBefore(node);
   * //   root
   * //  /    \
   * // node2 node
   * ```
   */
  moveBefore(target: LoroTreeNode): void;
  /**
   * Get the last mover of this node.
   */
  getLastMoveId(): { peer: PeerID, counter: number } | undefined;
  /**
   * Get the `Fractional Index` of the node.
   *
   * Note: the tree container must be attached to the document.
   */
  fractionalIndex(): string | undefined;
  __getClassname(): string;
  /**
   * Get the index of the node in the parent's children.
   */
  index(): number | undefined;
  /**
   * Get the creator of this node.
   */
  creator(): PeerID;
  /**
   * Move the tree node to be after the target node.
   *
   * @example
   * ```ts
   * import { LoroDoc } from "loro-crdt";
   *
   * const doc = new LoroDoc();
   * const tree = doc.getTree("tree");
   * const root = tree.createNode();
   * const node = root.createNode();
   * const node2 = root.createNode();
   * node2.moveAfter(node);
   * // root
   * //  /  \
   * // node node2
   * ```
   */
  moveAfter(target: LoroTreeNode): void;
  /**
   * The TreeID of the node.
   */
  readonly id: TreeID;
}
/**
 * `UndoManager` is responsible for handling undo and redo operations.
 *
 * By default, the maxUndoSteps is set to 100, mergeInterval is set to 1000 ms.
 *
 * Each commit made by the current peer is recorded as an undo step in the `UndoManager`.
 * Undo steps can be merged if they occur within a specified merge interval.
 *
 * Note that undo operations are local and cannot revert changes made by other peers.
 * To undo changes made by other peers, consider using the time travel feature.
 *
 * Once the `peerId` is bound to the `UndoManager` in the document, it cannot be changed.
 * Otherwise, the `UndoManager` may not function correctly.
 */
export class UndoManager {
  free(): void;
  /**
   * Get the value associated with the top redo stack item, if any.
   * Returns `undefined` if there is no redo item.
   */
  topRedoValue(): Value | undefined;
  /**
   * Get the value associated with the top undo stack item, if any.
   * Returns `undefined` if there is no undo item.
   */
  topUndoValue(): Value | undefined;
  /**
   * The number of max undo steps.
   * If the number of undo steps exceeds this number, the oldest undo step will be removed.
   */
  setMaxUndoSteps(steps: number): void;
  /**
   * Set the merge interval (in ms).
   *
   * If the interval is set to 0, the undo steps will not be merged.
   * Otherwise, the undo steps will be merged if the interval between the two steps is less than the given interval.
   */
  setMergeInterval(interval: number): void;
  /**
   * If a local event's origin matches the given prefix, it will not be recorded in the
   * undo stack.
   */
  addExcludeOriginPrefix(prefix: string): void;
  /**
   * `UndoManager` is responsible for handling undo and redo operations.
   *
   * PeerID cannot be changed during the lifetime of the UndoManager.
   *
   * Note that undo operations are local and cannot revert changes made by other peers.
   * To undo changes made by other peers, consider using the time travel feature.
   *
   * Each commit made by the current peer is recorded as an undo step in the `UndoManager`.
   * Undo steps can be merged if they occur within a specified merge interval.
   *
   * ## Config
   *
   * - `mergeInterval`: Optional. The interval in milliseconds within which undo steps can be merged. Default is 1000 ms.
   * - `maxUndoSteps`: Optional. The maximum number of undo steps to retain. Default is 100.
   * - `excludeOriginPrefixes`: Optional. An array of string prefixes. Events with origins matching these prefixes will be excluded from undo steps.
   * - `onPush`: Optional. A callback function that is called when an undo/redo step is pushed.
   *    The function can return a meta data value that will be attached to the given stack item.
   * - `onPop`: Optional. A callback function that is called when an undo/redo step is popped.
   *    The function will have a meta data value that was attached to the given stack item when
   *   `onPush` was called.
   */
  constructor(doc: LoroDoc, config: UndoConfig);
  /**
   * Get the peer id of the undo manager.
   */
  peer(): PeerID;
  /**
   * Redo the last undone operation.
   */
  redo(): boolean;
  /**
   * Undo the last operation.
   */
  undo(): boolean;
  clear(): void;
  /**
   * Can redo the last operation.
   */
  canRedo(): boolean;
  /**
   * Can undo the last operation.
   */
  canUndo(): boolean;
  /**
   * Clear only the redo stack, preserving the undo stack.
   *
   * This is useful when coordinating undo/redo across multiple participants
   * (e.g., multiple editors) where a new edit in one participant should
   * invalidate redo in all other participants.
   */
  clearRedo(): void;
  /**
   * Clear only the undo stack, preserving the redo stack.
   */
  clearUndo(): void;
}
/**
 * [VersionVector](https://en.wikipedia.org/wiki/Version_vector)
 * is a map from [PeerID] to [Counter]. Its a right-open interval.
 *
 * i.e. a [VersionVector] of `{A: 1, B: 2}` means that A has 1 atomic op and B has 2 atomic ops,
 * thus ID of `{client: A, counter: 1}` is out of the range.
 */
export class VersionVector {
  free(): void;
  /**
   * Get the counter of a peer.
   */
  get(peer_id: number | bigint | `${number}`): number | undefined;
  /**
   * Create a new version vector.
   */
  constructor(value: Map<PeerID, number> | Uint8Array | VersionVector | undefined | null);
  /**
   * Decode the version vector from a Uint8Array.
   */
  static decode(bytes: Uint8Array): VersionVector;
  /**
   * Encode the version vector into a Uint8Array.
   */
  encode(): Uint8Array;
  length(): number;
  remove(peer: PeerID): void;
  /**
   * set the exclusive ending point. target id will NOT be included by self
   */
  setEnd(id: { peer: PeerID, counter: number }): void;
  /**
   * Compare the version vector with another version vector.
   *
   * If they are concurrent, return undefined.
   */
  compare(other: VersionVector): number | undefined;
  /**
   * set the inclusive ending point. target id will be included
   */
  setLast(id: { peer: PeerID, counter: number }): void;
  /**
   * Convert the version vector to a Map
   */
  toJSON(): Map<PeerID, number>;
  /**
   * Create a new version vector from a Map.
   */
  static parseJSON(version: Map<PeerID, number>): VersionVector;
}
