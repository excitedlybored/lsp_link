import axios from 'axios';

export class SwiftHttpClient {
  /**
   * Egress: Outbound Axios HTTP Client to SWIFT payment network.
   */
  private baseUrl: string = 'https://api.swift.com/v2';

  async dispatchIso20022Payment(payload: any) {
    const response = await axios.post(`${this.baseUrl}/clearing/dispatch`, payload, {
      timeout: 5000,
    });
    return response.data;
  }
}
