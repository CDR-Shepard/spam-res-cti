import CallKit
import Foundation
import os

enum CallDirectoryError: Error {
    /// The App Group container, or the snapshot inside it, could not be read.
    case snapshotUnavailable
}

/// Publishes the app's directory snapshot to CallKit.
///
/// The extension does no networking and touches no Keychain: it reads the one
/// file the app writes into the App Group and streams it. The snapshot is
/// already sorted and deduped on the way in, so all that is left here is to
/// hand CallKit the entries in order.
///
/// This process runs on a ~12 MB budget and can be launched at any moment, so
/// it never holds the directory: `DirectoryStore.streamEntries` parses the
/// binary snapshot in fixed-size chunks and yields one record at a time, which
/// makes the footprint O(chunk) rather than O(entries). The entry ceiling
/// (`AppConfig.maxDirectoryEntries`, mirrored by the server's publish cap) is
/// therefore a practicality bound on how much CallKit is asked to ingest per
/// reload, and a safety valve — no longer this process's survival condition.
///
/// What has NOT changed is the posture on a bad file: a partial stream
/// published as a complete one is a directory of wrong labels, so any parse
/// failure cancels the whole request and leaves the last good load in place.
final class CallDirectoryHandler: CXCallDirectoryProvider, CXCallDirectoryExtensionContextDelegate {
    private let log = Logger(subsystem: AppConfig.extensionBundleIdentifier, category: "CallDirectory")

    override func beginRequest(with context: CXCallDirectoryExtensionContext) {
        context.delegate = self

        guard let store = DirectoryStore.appGroup(), let header = store.loadHeader() else {
            // No container, or a missing/short/unrecognised snapshot header.
            // Cancel rather than complete: a completed request with whatever we
            // managed to read would publish a partial — or empty — directory
            // over a previously good one. Cancelling leaves the last good load
            // in place and the app can ask for another reload later.
            log.error("no readable directory snapshot — cancelling the request")
            context.cancelRequest(withError: CallDirectoryError.snapshotUnavailable)
            return
        }

        // We only ever publish whole snapshots, so an incremental request
        // starts by clearing what CallKit already holds.
        if context.isIncremental {
            context.removeAllIdentificationEntries()
        }

        do {
            var published = 0
            try store.streamEntries { number, label in
                context.addIdentificationEntry(
                    withNextSequentialPhoneNumber: CXCallDirectoryPhoneNumber(number),
                    label: label
                )
                published += 1
            }
            log.info("published \(published) entries at version \(header.version)")
            context.completeRequest()
        } catch {
            // A record the parser could not vouch for. Everything already
            // handed to `context` is discarded with the request, so cancelling
            // is what keeps the previous load intact.
            log.error("directory snapshot unreadable mid-stream: \(String(describing: error), privacy: .public)")
            context.cancelRequest(withError: error)
        }
    }

    func requestFailed(for extensionContext: CXCallDirectoryExtensionContext, withError error: Error) {
        log.error("call directory request failed: \(error.localizedDescription, privacy: .public)")
    }
}
