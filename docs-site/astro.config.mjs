// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://marlburrow.github.io',
	base: '/hivekeep/docs',
	integrations: [
		starlight({
			expressiveCode: {
				themes: ['rose-pine', 'rose-pine-dawn'],
				styleOverrides: {
					borderRadius: '0.75rem',
					codePaddingBlock: '1rem',
					codePaddingInline: '1.25rem',
					frames: {
						editorTabBarBorderBottomColor: 'oklch(0.24 0.04 300)',
					},
				},
			},
			title: 'Hivekeep Docs',
			editLink: {
				baseUrl: 'https://github.com/MarlBurroW/hivekeep/edit/main/docs-site/',
			},
			lastUpdated: true,
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/MarlBurroW/hivekeep' },
			],
			customCss: ['./src/styles/custom.css'],
			components: {
				Header: './src/components/Header.astro',
				Head: './src/components/Head.astro',
				SiteTitle: './src/components/SiteTitle.astro',
				Sidebar: './src/components/Sidebar.astro',
				Hero: './src/components/Hero.astro',
				Footer: './src/components/Footer.astro',
				PageFrame: './src/components/PageFrame.astro',
				PageTitle: './src/components/PageTitle.astro',
				TableOfContents: './src/components/TableOfContents.astro',
				Pagination: './src/components/Pagination.astro',
				MobileTableOfContents: './src/components/MobileTableOfContents.astro',
				MobileMenuFooter: './src/components/MobileMenuFooter.astro',
				TwoColumnContent: './src/components/TwoColumnContent.astro',
			},
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Installation', slug: 'getting-started/installation' },
						{ label: 'Configuration', slug: 'getting-started/configuration' },
						{ label: 'Your First Agent', slug: 'getting-started/first-agent' },
						{ label: 'Autonomy Quickstart', slug: 'guides/autonomy-quickstart' },
					],
				},
				{
					label: 'Core Concepts',
					items: [
						{ label: 'Agents', slug: 'agents/overview' },
						{ label: 'System Prompts', slug: 'agents/system-prompts' },
						{ label: 'Native Tools', slug: 'agents/tools' },
						{ label: 'Memory', slug: 'agents/memory' },
						{ label: 'How Memory Works', slug: 'memory/how-it-works' },
						{ label: 'Memory Configuration', slug: 'memory/configuration' },
						{ label: 'Choosing a Model', slug: 'guides/model-selection' },
					],
				},
				{
					label: 'Agents Everywhere',
					items: [
						{ label: 'Channels Overview', slug: 'channels/overview' },
						{ label: 'Telegram', slug: 'channels/telegram' },
						{ label: 'Discord', slug: 'channels/discord' },
						{ label: 'Slack', slug: 'channels/slack' },
						{ label: 'WhatsApp', slug: 'channels/whatsapp' },
						{ label: 'Signal', slug: 'channels/signal' },
						{ label: 'Matrix', slug: 'channels/matrix' },
					],
				},
				{
					label: 'Automation',
					items: [
						{
							label: 'Blueprints',
							items: [
								{ label: 'GitHub Issue Processor', slug: 'guides/blueprints/github-issue-processor' },
								{ label: 'Daily Digest', slug: 'guides/blueprints/daily-digest' },
							],
						},
					],
				},
				{
					label: 'Extending Hivekeep',
					items: [
						{ label: 'Mini-Apps Overview', slug: 'mini-apps/overview' },
						{ label: 'Mini-Apps: Getting Started', slug: 'mini-apps/getting-started' },
						{ label: 'Mini-Apps: Components', slug: 'mini-apps/components' },
						{ label: 'Mini-Apps: Hooks', slug: 'mini-apps/hooks' },
						{ label: 'Mini-Apps: SDK Reference', slug: 'mini-apps/sdk-reference' },
						{ label: 'Mini-Apps: Guidelines', slug: 'mini-apps/guidelines' },
						{ label: 'Mini-Apps: Backend (_server.js)', slug: 'mini-apps/backend' },
						{ label: 'Mini-Apps: Examples', slug: 'mini-apps/examples' },
					],
				},
				{
					label: 'Plugins',
					items: [
						{ label: 'Overview', slug: 'plugins/overview' },
						{ label: 'Developing Plugins', slug: 'plugins/developing' },
						{ label: 'Tutorial: Mistral Provider', slug: 'plugins/tutorial-mistral' },
						{ label: 'Plugin API', slug: 'plugins/api' },
						{ label: 'Plugin Registry', slug: 'plugins/store' },
						{ label: 'Migrating from 0.1', slug: 'plugins/migrating-from-01' },
					],
				},
				{
					label: 'Providers',
					items: [
						{ label: 'Supported Providers', slug: 'providers/supported' },
						{ label: 'Adding Custom', slug: 'providers/custom' },
					],
				},
				{
					label: 'API Reference',
					items: [
						{ label: 'REST Endpoints', slug: 'api/rest' },
						{ label: 'SSE Events', slug: 'api/sse' },
					],
				},
			],
		}),
	],
});
