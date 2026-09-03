import XCTest

final class DeviceRegistrationClientTests: XCTestCase {
    func testRequestCarriesSessionBearerAndLabel() throws {
        let req = try registerDeviceRequest(baseURL: URL(string: "https://api.example.test")!, sessionToken: "sess_1", label: "Jane's iPhone")
        XCTAssertEqual(req.url?.path, "/mobile/register")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer sess_1")
        let body = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: String]
        XCTAssertEqual(body["deviceLabel"], "Jane's iPhone")
    }
    func testDecode() throws {
        let ok = try decodeRegistration(#"{"deviceToken":"dev_abc","deviceId":"d1"}"#.data(using: .utf8)!, status: 200)
        XCTAssertEqual(ok, DeviceRegistration(deviceToken: "dev_abc", deviceId: "d1"))
        XCTAssertThrowsError(try decodeRegistration(Data(), status: 401))
    }
}
