import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import pino from "pino";

const log = pino({ name: "github-octokit" });

/** Per-request retries after GitHub signals rate limits (each REST call gets its own counter). */
const maxRateLimitRetriesPerRequest = 8;

export const GitHubOctokit = Octokit.plugin(retry, throttling);

export type GitHubOctokitClient = InstanceType<typeof GitHubOctokit>;

export function createGitHubOctokit(auth: string): GitHubOctokitClient {
  return new GitHubOctokit({
    auth,
    request: {
      retries: 4,
    },
    throttle: {
      onRateLimit(retryAfter, options, _octokit, retryCount) {
        log.warn(
          {
            retryAfterSec: retryAfter,
            retryCount,
            method: options.method,
            url: String(options.url),
          },
          "GitHub primary rate limit — waiting for reset then retrying request"
        );
        return retryCount < maxRateLimitRetriesPerRequest;
      },
      onSecondaryRateLimit(retryAfter, options, _octokit, retryCount) {
        log.warn(
          {
            retryAfterSec: retryAfter,
            retryCount,
            method: options.method,
            url: String(options.url),
          },
          "GitHub secondary rate limit — backing off then retrying request"
        );
        return retryCount < maxRateLimitRetriesPerRequest;
      },
    },
  });
}
