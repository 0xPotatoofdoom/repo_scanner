import { Octokit } from '@octokit/rest';
import nodemailer from 'nodemailer';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class GitHubMonitor {
    constructor() {
        this.config = this.loadConfig();
        this.octokit = new Octokit({
            auth: this.config.github.token
        });
        this.transporter = nodemailer.createTransport(this.config.email.smtp);
        this.storageFile = path.join(__dirname, 'lastChecked.json');
        this.lastCheckedCommits = this.loadLastCheckedCommits();
    }

    loadLastCheckedCommits() {
        try {
            if (fs.existsSync(this.storageFile)) {
                const data = fs.readFileSync(this.storageFile, 'utf8');
                const parsed = JSON.parse(data);
                return new Map(Object.entries(parsed));
            }
        } catch (error) {
            console.error('Error loading last checked commits:', error);
        }
        return new Map();
    }

    saveLastCheckedCommits() {
        try {
            const data = Object.fromEntries(this.lastCheckedCommits);
            fs.writeFileSync(this.storageFile, JSON.stringify(data, null, 2));
            console.log('Saved last checked commits to storage');
        } catch (error) {
            console.error('Error saving last checked commits:', error);
        }
    }

    loadConfig() {
        try {
            const configFile = fs.readFileSync(path.join(__dirname, 'config.yml'), 'utf8');
            let config = yaml.load(configFile);
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
        return { owner: match[1], repo: match[2].replace('.git', '') };
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

    async getCommitDetails(owner, repo, commitSha) {
        try {
            const response = await this.octokit.repos.getCommit({
                owner,
                repo,
                ref: commitSha
            });
            return response.data;
        } catch (error) {
            console.error(`Error fetching commit details for ${commitSha}:`, error);
            return null;
        }
    }

    async getFileContent(owner, repo, fileSha) {
        try {
            const response = await this.octokit.git.getBlob({
                owner,
                repo,
                file_sha: fileSha
            });
            
            // Decode base64 content
            const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
            return content;
        } catch (error) {
            console.error(`Error fetching file content for ${fileSha}:`, error);
            return null;
        }
    }

    async scanCommitForKeywords(owner, repo, commit, keywords) {
        const findings = {
            inMessage: [],
            inFiles: []
        };

        // Check commit message
        const message = commit.commit.message.toLowerCase();
        findings.inMessage = keywords.filter(keyword => 
            message.includes(keyword.toLowerCase())
        );

        // Get detailed commit info including file changes
        const commitDetails = await this.getCommitDetails(owner, repo, commit.sha);
        if (!commitDetails) return findings;

        // Scan each file in the commit
        for (const file of commitDetails.files) {
            console.log(`Scanning file: ${file.filename}`);
            
            // Skip binary files and large files
            if (file.status === 'removed' || !file.sha || file.size > 1000000) {
                continue;
            }

            // Get file content
            const content = await this.getFileContent(owner, repo, file.sha);
            if (!content) continue;

            // Check for keywords in file content
            const contentLower = content.toLowerCase();
            const foundInFile = keywords.filter(keyword =>
                contentLower.includes(keyword.toLowerCase())
            );

            if (foundInFile.length > 0) {
                findings.inFiles.push({
                    filename: file.filename,
                    keywords: foundInFile
                });
            }
        }

        return findings;
    }

    async sendAlert(repoUrl, branch, commit, findings) {
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
                
                ${findings.inMessage.length > 0 ? `
                    <h3>Keywords found in commit message:</h3>
                    <p>${findings.inMessage.join(', ')}</p>
                    <p><strong>Message:</strong></p>
                    <pre>${commit.commit.message}</pre>
                ` : ''}
                
                ${findings.inFiles.length > 0 ? `
                    <h3>Keywords found in files:</h3>
                    <ul>
                        ${findings.inFiles.map(file => `
                            <li>
                                <strong>${file.filename}</strong>: 
                                ${file.keywords.join(', ')}
                            </li>
                        `).join('')}
                    </ul>
                ` : ''}
                
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
            console.log(`\nChecking ${owner}/${repo} (${branch})...`);
            const commits = await this.getLatestCommits(owner, repo, branch);
            if (!commits.length) continue;

            const repoKey = `${repoConfig.url}/${branch}`;
            const lastCheckedCommitSha = this.lastCheckedCommits.get(repoKey);

            let newCommitsFound = false;
            for (const commit of commits) {
                if (commit.sha === lastCheckedCommitSha) {
                    console.log(`Reached previously checked commit: ${commit.sha}`);
                    break;
                }

                console.log(`\nScanning commit: ${commit.sha}`);
                const findings = await this.scanCommitForKeywords(owner, repo, commit, repoConfig.keywords);
                
                if (findings.inMessage.length > 0 || findings.inFiles.length > 0) {
                    console.log('Keywords found:', {
                        inMessage: findings.inMessage,
                        inFiles: findings.inFiles.map(f => `${f.filename}: ${f.keywords.join(', ')}`)
                    });
                    await this.sendAlert(repoConfig.url, branch, commit, findings);
                }
                newCommitsFound = true;
            }

            if (commits.length > 0 && newCommitsFound) {
                this.lastCheckedCommits.set(repoKey, commits[0].sha);
                this.saveLastCheckedCommits();
                console.log(`Updated last checked commit for ${repoKey}: ${commits[0].sha}`);
            }
        }
    }

    async monitorRepositories() {
        console.log('\nChecking repositories...');
        try {
            for (const repoConfig of this.config.repositories) {
                await this.checkRepository(repoConfig);
            }
        } catch (error) {
            console.error('Error monitoring repositories:', error);
        }
    }

    start() {
        console.log('GitHub repository monitor starting...');
        console.log('Last checked commits:', Object.fromEntries(this.lastCheckedCommits));
        
        // Initial run
        this.monitorRepositories();

        // Schedule regular checks
        const intervalMs = this.config.github.checkInterval * 60 * 1000;
        setInterval(() => this.monitorRepositories(), intervalMs);

        // Save state on process termination
        process.on('SIGINT', () => {
            console.log('\nSaving state before exit...');
            this.saveLastCheckedCommits();
            process.exit();
        });

        process.on('SIGTERM', () => {
            console.log('\nSaving state before exit...');
            this.saveLastCheckedCommits();
            process.exit();
        });
    }
}

// Start the monitor
const monitor = new GitHubMonitor();
monitor.start();