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
/// file the app writes into the App Group and streams it. It also runs on a
/// tight memory budget and can be launched at any moment, which is why the
/// snapshot is already sorted and validated on the way in — all that is left
/// here is to hand CallKit the entries in order.
///
/// That budget is why the entry count is bounded rather than trusted: past
/// roughly `AppConfig.maxDirectoryEntries` entries iOS jetsams this process
/// mid-stream — a failing reload, no label on any call, nothing the rep can
/// act on. The bound that actually protects this process is the SERVER's
/// publish cap (the app's write-side cap backs it up); `DirectoryStore.load`
/// truncates too, but only after the whole file is decoded, so it cannot
/// save an oversized snapshot from the decode cost itself.
final class CallDirectoryHandler: CXCallDirectoryProvider, CXCallDirectoryExtensionContextDelegate {
    private let log = Logger(subsystem: AppConfig.extensionBundleIdentifier, category: "CallDirectory")

    override func beginRequest(with context: CXCallDirectoryExtensionContext) {
        context.delegate = self

        guard let store = DirectoryStore.appGroup(), let snapshot = store.load() else {
            // No container, or a missing/corrupt/out-of-order snapshot. Cancel
            // rather than complete: a completed request with whatever we
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

        for entry in snapshot.entries {
            let number = CXCallDirectoryPhoneNumber(DirectoryStore.phoneNumberValue(entry.e164))
            context.addIdentificationEntry(withNextSequentialPhoneNumber: number, label: entry.label)
        }

        log.info("published \(snapshot.entries.count) entries at version \(snapshot.version)")
        context.completeRequest()
    }

    func requestFailed(for extensionContext: CXCallDirectoryExtensionContext, withError error: Error) {
        log.error("call directory request failed: \(error.localizedDescription, privacy: .public)")
    }
}
