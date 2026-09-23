// Only sites whose site page shows a Filmstrip section get an embed.
export default {
	pagination: {
		data: "sites.entries",
		size: 1,
		alias: "entry",
		before: (entries) => entries.filter((entry) => entry.filmstrip && entry.filmstrip.distinct > 1),
	},
};
