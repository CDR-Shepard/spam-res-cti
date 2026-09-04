import Foundation

/// The wrap-up disposition list.
///
/// Copied **verbatim**, and in order, from
/// `apps/cti-web/src/components/WrapupForm.tsx`'s `DISPOSITIONS`. These are not
/// display labels the phone is free to reword: the chosen string is what
/// `POST /calls/:id/disposition` stores, what the Salesforce Task carries, and
/// what every downstream report groups by. A phone that sent "Voicemail" where
/// the web sends "Left voicemail" would split one customer's reporting in two
/// and nothing in the pipeline would notice.
///
/// `DispositionsTests` pins the list against the web app's own array.
enum Dispositions {
    static let all: [String] = [
        "Connected", "Left voicemail", "No answer", "Wrong number",
        "Do not call", "Busy", "Bad number", "Call back",
    ]
}
