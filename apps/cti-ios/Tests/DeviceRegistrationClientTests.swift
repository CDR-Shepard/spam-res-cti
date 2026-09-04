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

    /// `DELETE /mobile/devices/:id` — the sign-out counterpart to
    /// `/mobile/register`. Session auth, not device auth: the route resolves a
    /// SESSION and only ever revokes that rep's own devices, so the bearer has
    /// to be the Salesforce session token rather than the device token being
    /// revoked.
    func testRevokeRequestIsADeleteOnTheDeviceRowWithTheSessionBearer() {
        let req = revokeDeviceRequest(
            baseURL: URL(string: "https://api.example.test")!, sessionToken: "sess_1", deviceId: "d1"
        )
        XCTAssertEqual(req.httpMethod, "DELETE")
        XCTAssertEqual(req.url?.path, "/mobile/devices/d1")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer sess_1")
        XCTAssertNil(req.httpBody, "the id is in the path; there is nothing to send")
    }
}
