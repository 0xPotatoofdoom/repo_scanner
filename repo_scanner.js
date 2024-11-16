import { Octokit } from '@octokit/rest';
import nodemailer from 'nodemailer';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Configure dotenv
dotenv.config();

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class GitHubMonitor {
    constructor() {
        this.config = this.loadConfig();
        this.octokit = new Octokit({
            auth: this.config.github.token
        });
        this.transporter = nodemailer.createTransport(this.config.email.smtp);
        this.lastCheckedCommits = new Map();
    }

    loadConfig() {
        try {
            const configFile = fs.readFileSync(path.join(__dirname, 'config.yml'), 'utf8');
            let config = yaml.load(configFile);
            
            // Replace environment variables
            const configString = JSON.stringify(config);
            const replacedConfig = configString.replace(/\${(\w+)}/g, (_, key) => {
                const value = process.env[key];
                if (!value) {
                    throw new Error(`Environment variable ${key} is not set`);
                }
                return value;
            });
            
            return JSON.parse(replacedConfig);
        } catch (error) {
            console.error('Error loading config:', error);
            process.exit(1);
        }
    }

    parseGitHubUrl(url) {
        const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (!match) {
            throw new Error(`Invalid GitHub URL: ${url}`);
        }
        return { owner: match[1], repo: match[2] };
    }

    async getLatestCommits(owner, repo, branch) {
        try {
            const response = await this.octokit.repos.listCommits({
                owner,
                repo,
                sha: branch,
                per_page: 10
            });
            return response.data;
        } catch (error) {
            console.error(`Error fetching commits for ${owner}/${repo}/${branch}:`, error);
            return [];
        }
    }

    checkCommitForKeywords(commit, keywords) {
        const message = commit.commit.message.toLowerCase();
        return keywords.filter(keyword => 
            message.includes(keyword.toLowerCase())
        );
    }

    async sendAlert(repoUrl, branch, commit, foundKeywords) {
        const emailContent = {
            from: this.config.email.from,
            to: this.config.email.to,
            subject: `Keyword Alert: ${repoUrl} (${branch})`,
            html: `
                <h2>Keywords found in recent commit</h2>
                <p><strong>Repository:</strong> ${repoUrl}</p>
                <p><strong>Branch:</strong> ${branch}</p>
                <p><strong>Commit:</strong> ${commit.sha}</p>
                <p><strong>Author:</strong> ${commit.commit.author.name}</p>
                <p><strong>Keywords found:</strong> ${foundKeywords.join(', ')}</p>
                <p><strong>Message:</strong></p>
                <pre>${commit.commit.message}</pre>
                <p><a href="${commit.html_url}">View commit on GitHub</a></p>
            `
        };

        try {
            await this.transporter.sendMail(emailContent);
            console.log(`Alert sent for ${repoUrl} (${branch})`);
        } catch (error) {
            console.error('Error sending email:', error);
        }
    }

    async verifyRepository(owner, repo) {
        try {
            const response = await this.octokit.repos.get({
                owner,
                repo,
            });
            console.log(`✓ Repository verified: ${owner}/${repo}`);
            console.log(`Default branch: ${response.data.default_branch}`);
            return true;
        } catch (error) {
            console.error(`✗ Repository not found or not accessible: ${owner}/${repo}`);
            console.error(`Error: ${error.message}`);
            return false;
        }
    }

    async getLatestCommits(owner, repo, branch) {
        try {
            // First verify the repository exists and is accessible
            const repoExists = await this.verifyRepository(owner, repo);
            if (!repoExists) {
                return [];
            }

            // Get repository info to check default branch
            const repoInfo = await this.octokit.repos.get({
                owner,
                repo
            });

            // Use default branch if no branch specified
            const targetBranch = branch || repoInfo.data.default_branch;
            console.log(`Fetching commits from ${owner}/${repo}:${targetBranch}`);

            const response = await this.octokit.repos.listCommits({
                owner,
                repo,
                sha: targetBranch,
                per_page: 10
            });
            
            console.log(`Found ${response.data.length} commits`);
            return response.data;
        } catch (error) {
            if (error.status === 404) {
                console.error(`Branch ${branch} not found in ${owner}/${repo}`);
            } else {
                console.error(`Error fetching commits for ${owner}/${repo}/${branch}:`, error.message);
            }
            return [];
        }
    }

    async checkRepository(repoConfig) {
        try {
            const { owner, repo } = this.parseGitHubUrl(repoConfig.url);
            console.log(`\nChecking repository: ${owner}/${repo}`);
            
            // Get repository info
            const repoInfo = await this.octokit.repos.get({
                owner,
                repo
            });
            
            // If no branches specified, use default branch
            const branches = repoConfig.branches?.length > 0 
                ? repoConfig.branches 
                : [repoInfo.data.default_branch];
            
            for (const branch of branches) {
                console.log(`\nChecking branch: ${branch}`);
                const commits = await this.getLatestCommits(owner, repo, branch);
                if (!commits.length) {
                    console.log(`No commits found in ${branch}`);
                    continue;
                }

                const repoKey = `${repoConfig.url}/${branch}`;
                const lastCheckedCommitSha = this.lastCheckedCommits.get(repoKey);

                for (const commit of commits) {
                    if (commit.sha === lastCheckedCommitSha) break;

                    const foundKeywords = this.checkCommitForKeywords(commit, repoConfig.keywords);
                    if (foundKeywords.length > 0) {
                        console.log(`Found keywords in commit ${commit.sha}: ${foundKeywords.join(', ')}`);
                        await this.sendAlert(repoConfig.url, branch, commit, foundKeywords);
                    }
                }

                if (commits.length > 0) {
                    this.lastCheckedCommits.set(repoKey, commits[0].sha);
                }
            }
        } catch (error) {
            console.error(`Error checking repository ${repoConfig.url}:`, error.message);
        }
    }

    async monitorRepositories() {
        console.log('Checking repositories...');
        for (const repoConfig of this.config.repositories) {
            await this.checkRepository(repoConfig);
        }
    }

    start() {
        console.log('GitHub repository monitor starting...');
        // Initial run
        this.monitorRepositories();

        // Schedule regular checks
        const intervalMs = this.config.github.checkInterval * 60 * 1000;
        setInterval(() => this.monitorRepositories(), intervalMs);
    }
}

// Start the monitor
const monitor = new GitHubMonitor();
monitor.start();