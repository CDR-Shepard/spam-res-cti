import XCTest

final class AppConfigTests: XCTestCase {
    func testManagedConfigOverridesBaseURL() {
        let url = AppConfig.resolveBaseURL(managed: ["apiBaseUrl": "https://cti.example.test"])
        XCTAssertEqual(url, URL(string: "https://cti.example.test")!)
    }
    func testMissingOrBadManagedValueFallsBackToProduction() {
        XCTAssertEqual(AppConfig.resolveBaseURL(managed: nil), AppConfig.productionBaseURL)
        XCTAssertEqual(AppConfig.resolveBaseURL(managed: ["apiBaseUrl": "not a url"]), AppConfig.productionBaseURL)
        XCTAssertEqual(AppConfig.resolveBaseURL(managed: ["apiBaseUrl": "http://insecure.example"]), AppConfig.productionBaseURL)
    }
}
