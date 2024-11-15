require('dotenv').config();
const { Octokit } = require('@octokit/rest');
const nodemailer = require('nodemailer');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

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
            // Load and parse YAML file
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

    async checkRepository(repoConfig) {
        const { owner, repo } = this.parseGitHubUrl(repoConfig.url);
        
        for (const branch of repoConfig.branches) {
            const commits = await this.getLatestCommits(owner, repo, branch);
            if (!commits.length) continue;

            const repoKey = `${repoConfig.url}/${branch}`;
            const lastCheckedCommitSha = this.lastCheckedCommits.get(repoKey);

            for (const commit of commits) {
                if (commit.sha === lastCheckedCommitSha) break;

                const foundKeywords = this.checkCommitForKeywords(commit, repoConfig.keywords);
                if (foundKeywords.length > 0) {
                    await this.sendAlert(repoConfig.url, branch, commit, foundKeywords);
                }
            }

            if (commits.length > 0) {
                this.lastCheckedCommits.set(repoKey, commits[0].sha);
            }
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

const monitor = new GitHubMonitor();
monitor.start();